import { errorMessage } from "@browserforge/shared";
import type { Rule } from "../rules/model";
import { mergeRulesOnJoin } from "../sync/codec";
import type { SyncStore } from "../sync/store";
import type { ActivityRecorder } from "./activity-recorder";

export interface SyncMirrorView {
  rules: readonly Rule[];
  syncEnabled: boolean;
}

export interface SyncMirrorDeps {
  store: SyncStore;
  isPro(): Promise<boolean>;
  /** Writes rules to local storage; the rules watcher then rebuilds and republishes. */
  saveLocalRules(rules: Rule[]): Promise<void>;
  recorder: ActivityRecorder;
  view(): SyncMirrorView;
  /** Random id of this device, so its own writes can be told apart from other devices'. */
  origin: string;
  debounceMs?: number;
}

export interface SyncMirror {
  /** Publishes the local rules after a quiet period (coalesces rapid edits). */
  scheduleWrite(): void;
  /** Sync was just switched on: adopt or merge the remote set, or publish ours. */
  join(): Promise<void>;
  /** Another device published: adopt its rules unless the change is our own echo. */
  applyRemoteChange(): Promise<void>;
}

export const SYNC_WRITE_DEBOUNCE_MS = 1_500;

/**
 * Mirrors the local rules into sync storage (Pro). Local storage stays the source of truth;
 * `lastSyncedText` remembers what was last written to or applied from sync so an echo never
 * loops, and `lastSyncWrite` lets older remote snapshots be ignored.
 */
export function createSyncMirror(deps: SyncMirrorDeps): SyncMirror {
  const debounceMs = deps.debounceMs ?? SYNC_WRITE_DEBOUNCE_MS;
  let lastSyncWrite = 0;
  let lastSyncedText: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function isActive(): Promise<boolean> {
    return deps.view().syncEnabled && (await deps.isPro());
  }

  function adoptRemoteVersion(rules: readonly Rule[], updatedAt: number): void {
    lastSyncWrite = updatedAt;
    lastSyncedText = JSON.stringify(rules);
  }

  async function publishLocalRules(): Promise<void> {
    if (!(await deps.isPro())) return;
    const rules = deps.view().rules;
    const text = JSON.stringify(rules);
    if (text === lastSyncedText) return;
    try {
      const meta = await deps.store.write(rules, deps.origin);
      lastSyncWrite = meta.updatedAt;
      lastSyncedText = text;
    } catch (e) {
      await deps.recorder.recordError(`Sync write failed: ${errorMessage(e)}`);
    }
  }

  function scheduleWrite(): void {
    if (!deps.view().syncEnabled) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void publishLocalRules();
    }, debounceMs);
  }

  /**
   * If another device already published a rule set, adopt it (merged with whatever is local)
   * rather than overwriting it with this device's copy; the merged set is then written back
   * through the normal rules watcher. Without a remote set, publish ours.
   */
  async function join(): Promise<void> {
    if (!(await isActive())) return;
    let snapshot;
    try {
      snapshot = await deps.store.read();
    } catch (e) {
      await deps.recorder.recordError(`Sync read failed: ${errorMessage(e)}`);
      return;
    }
    if (!snapshot) {
      scheduleWrite();
      return;
    }
    const local = deps.view().rules;
    const merged = mergeRulesOnJoin(snapshot.rules, local);
    // Marks the remote copy as "already synced": if the merge adds nothing, no write follows;
    // if it does, the rules watcher publishes the merged set.
    adoptRemoteVersion(snapshot.rules, snapshot.meta.updatedAt);
    if (JSON.stringify(merged) !== JSON.stringify(local)) await deps.saveLocalRules(merged);
    else scheduleWrite();
  }

  async function applyRemoteChange(): Promise<void> {
    if (!(await isActive())) return;
    const snapshot = await deps.store.read();
    if (!snapshot) return;
    if (snapshot.meta.origin === deps.origin || snapshot.meta.updatedAt <= lastSyncWrite) return;
    adoptRemoteVersion(snapshot.rules, snapshot.meta.updatedAt);
    await deps.saveLocalRules(snapshot.rules);
  }

  return { scheduleWrite, join, applyRemoteChange };
}

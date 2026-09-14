/**
 * Composes the background services and owns the rebuild cycle: load storage, compile, deploy to
 * DNR, refresh the in-memory state. Everything the browser provides arrives through ports, so
 * the whole orchestration runs in unit tests with in-memory fakes.
 */

import { errorMessage, type Clock } from "@browserforge/shared";
import type { DnrRule } from "../dnr";
import type { StatusResponse } from "../messages";
import type { Rule } from "../rules/model";
import { syncJustEnabled, withSettingsDefaults, type Settings } from "../settings";
import type { SyncStore } from "../sync/store";
import {
  createActivityRecorder,
  type ActivityLogStore,
  type ActivityRecorder,
} from "./activity-recorder";
import {
  createCopyCleanLink,
  type ContentScriptMessenger,
  type CopyCleanLinkRequest,
} from "./copy-clean-link";
import {
  createRedirectFallback,
  type RedirectFallback,
  type RedirectTabsPort,
} from "./redirect-fallback";
import { createRuleDeployer, type DnrPort, type RuleDeployer } from "./rule-deployer";
import { initialState, toStatusResponse, type BackgroundState } from "./state";
import { createSyncMirror, type SyncMirror } from "./sync-mirror";

/** A typed storage slot; `WxtStorageItem<T>` satisfies it. */
export interface ValueStore<T> {
  getValue(): Promise<T>;
  setValue(value: T): Promise<void>;
}

export interface BackgroundDeps {
  dnr: DnrPort;
  tabs: RedirectTabsPort & ContentScriptMessenger;
  rulesStore: ValueStore<Rule[]>;
  allowlistStore: ValueStore<string[]>;
  settingsStore: ValueStore<Partial<Settings> | null>;
  logStore: ActivityLogStore;
  syncStore: SyncStore;
  syncOrigin: string;
  isPro(): Promise<boolean>;
  loadTrackingRules(): Promise<DnrRule[]>;
  clock: Clock;
}

export interface BackgroundService {
  /** Serialised: loads storage, compiles, pushes DNR, refreshes in-memory state. */
  rebuild(): Promise<void>;
  /** Resolves after the most recent rebuild, so callers see the state after their own write. */
  whenIdle(): Promise<void>;
  getStatus(): Promise<StatusResponse>;
  readonly state: Readonly<BackgroundState>;
  readonly fallback: RedirectFallback;
  readonly mirror: SyncMirror;
  readonly deployer: RuleDeployer;
  readonly recorder: ActivityRecorder;
  copyCleanLink(request: CopyCleanLinkRequest): Promise<void>;
  onRulesChanged(): Promise<void>;
  onAllowlistChanged(): Promise<void>;
  onSettingsChanged(next: Settings | null, previous: Settings | null): Promise<void>;
}

export function createBackgroundService(deps: BackgroundDeps): BackgroundService {
  const state = initialState();
  const recorder = createActivityRecorder(deps.logStore, deps.clock);
  const deployer = createRuleDeployer(deps.dnr, recorder);
  let rebuildChain: Promise<void> = Promise.resolve();

  async function loadState(): Promise<void> {
    const [rules, allowlist, settings] = await Promise.all([
      deps.rulesStore.getValue(),
      deps.allowlistStore.getValue(),
      deps.settingsStore.getValue(),
    ]);
    state.rules = rules;
    state.enabledRules = rules.filter((r) => r.enabled);
    state.allowlist = allowlist;
    state.settings = withSettingsDefaults(settings);
  }

  async function applyTrackingToggle(): Promise<void> {
    try {
      await deployer.setTrackingEnabled(state.settings.trackingEnabled);
    } catch (e) {
      state.lastError = `Tracking ruleset toggle failed: ${errorMessage(e)}`;
    }
  }

  async function doRebuild(): Promise<void> {
    try {
      await loadState();
      const deployment = await deployer.deploy(state.rules, state.allowlist);
      state.jsOnlyRuleIds = deployment.jsOnlyRuleIds;
      state.jsOnlyReasons = deployment.jsOnlyReasons;
      state.dnrRuleCount = deployment.dnrRuleCount;
      state.lastError = null;
      state.lastRebuildAt = deps.clock();
      await applyTrackingToggle();
    } catch (e) {
      state.lastError = errorMessage(e);
      await recorder.recordError(`Rebuild failed: ${state.lastError}`);
    }
  }

  function rebuild(): Promise<void> {
    rebuildChain = rebuildChain.then(doRebuild, doRebuild);
    return rebuildChain;
  }

  const ready = rebuild();

  const fallback = createRedirectFallback({
    tabs: deps.tabs,
    recorder,
    clock: deps.clock,
    ready,
    view: () => state,
  });

  const mirror = createSyncMirror({
    store: deps.syncStore,
    isPro: deps.isPro,
    saveLocalRules: (rules) => deps.rulesStore.setValue(rules),
    recorder,
    origin: deps.syncOrigin,
    view: () => ({ rules: state.rules, syncEnabled: state.settings.syncEnabled }),
  });

  const copyCleanLink = createCopyCleanLink({
    messenger: deps.tabs,
    recorder,
    loadTrackingRules: deps.loadTrackingRules,
    isTrackingEnabled: () => state.settings.trackingEnabled,
  });

  return {
    state,
    fallback,
    mirror,
    deployer,
    recorder,
    copyCleanLink,
    rebuild,
    whenIdle: () => rebuildChain,
    getStatus: async () => {
      await rebuildChain;
      return toStatusResponse(state);
    },
    onRulesChanged: () => rebuild().then(() => mirror.scheduleWrite()),
    onAllowlistChanged: rebuild,
    onSettingsChanged: (next, previous) =>
      rebuild().then(() =>
        syncJustEnabled(next, previous) ? mirror.join() : mirror.scheduleWrite(),
      ),
  };
}

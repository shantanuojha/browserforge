import { defineStorageKey, normalizeHost } from "@browserforge/shared";

/**
 * Settings schema for CookieSweep. Everything lives in `storage.local`; the
 * `settingsKey` / `activityLogKey` helpers are the only storage access points.
 *
 * `normalizeSettings` is permissive so older/partial stored objects (or a
 * hand-edited import) always resolve to a complete, valid `Settings` value.
 */

export type ListType = "white" | "grey";

export interface ListEntry {
  /** Host pattern using the shared `hostMatchesPattern` syntax (`example.com`, `*.example.com`, `*example.com`). */
  pattern: string;
  /** `white` = always keep. `grey` = keep until the browser restarts. */
  listType: ListType;
  /** Restrict the entry to one cookie store (container / incognito). Omitted = every store. */
  storeId?: string;
}

export type CleanupTrigger = "tab-close" | "domain-change" | "startup" | "manual";

export interface Settings {
  /** Global pause switch. When false, automatic cleanups do not run (manual ones still do). */
  enabled: boolean;
  /** Seconds to wait after a trigger before cleaning. 0 = immediately. */
  delaySeconds: number;
  /** Also clear localStorage / IndexedDB / Cache Storage / service workers for cleaned domains. */
  cleanSiteData: boolean;
  /**
   * On browser startup, run a full sweep (everything not whitelisted and not open in a tab).
   * When false, startup only expires the greylist.
   */
  cleanOnStartup: boolean;
  /** Flash the toolbar badge with the number of removed cookies after each cleanup. */
  notifications: boolean;
  lists: ListEntry[];
}

export const ACTIVITY_LOG_CAP = 500;
export const MIN_DELAY_SECONDS = 0;
export const MAX_DELAY_SECONDS = 3600;

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  enabled: true,
  delaySeconds: 15,
  cleanSiteData: true,
  cleanOnStartup: false,
  notifications: false,
  lists: [],
});

export interface ActivityEntry {
  id: string;
  /** Epoch milliseconds. */
  at: number;
  trigger: CleanupTrigger;
  storeId: string;
  domains: string[];
  cookiesRemoved: number;
  /** Number of domains whose site data (storage/cache) was cleared. */
  siteDataDomains: number;
}

export const SETTINGS_STORAGE_KEY = "cookiesweep:settings";
export const ACTIVITY_STORAGE_KEY = "cookiesweep:activity";

export const settingsKey = defineStorageKey<Settings>(SETTINGS_STORAGE_KEY, {
  ...DEFAULT_SETTINGS,
  lists: [],
});
export const activityLogKey = defineStorageKey<ActivityEntry[]>(ACTIVITY_STORAGE_KEY, []);

const TRIGGERS: readonly CleanupTrigger[] = ["tab-close", "domain-change", "startup", "manual"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function clampDelay(value: unknown, fallback = DEFAULT_SETTINGS.delaySeconds): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, Math.round(n)));
}

export function normalizePattern(pattern: string): string {
  const trimmed = pattern.trim().toLowerCase();
  if (trimmed.startsWith("*.")) return "*." + normalizeHost(trimmed.slice(2));
  if (trimmed.startsWith("*")) return "*" + normalizeHost(trimmed.slice(1));
  return normalizeHost(trimmed);
}

export function isValidPattern(pattern: string): boolean {
  const normalized = normalizePattern(pattern);
  const body = normalized.replace(/^\*\.?/, "");
  if (!body) return false;
  if (/\s/.test(body)) return false;
  if (body.includes("/") || body.includes("*")) return false;
  return true;
}

export function normalizeListEntry(raw: unknown): ListEntry | null {
  if (!isRecord(raw)) return null;
  const patternRaw = raw.pattern;
  if (typeof patternRaw !== "string" || !isValidPattern(patternRaw)) return null;
  // Unknown list types degrade to "white" (keeping cookies is the safe failure mode).
  const listType = String(raw.listType ?? "").toLowerCase();
  const type: ListType = listType === "grey" || listType === "gray" ? "grey" : "white";
  const entry: ListEntry = { pattern: normalizePattern(patternRaw), listType: type };
  if (typeof raw.storeId === "string" && raw.storeId.trim() !== "") {
    entry.storeId = raw.storeId.trim();
  }
  return entry;
}

export function listEntryKey(entry: Pick<ListEntry, "pattern" | "storeId">): string {
  return `${entry.storeId ?? "*"}|${normalizePattern(entry.pattern)}`;
}

/** Deduplicate entries by pattern + store. Later entries win (so re-adding flips the list type). */
export function dedupeListEntries(entries: readonly ListEntry[]): ListEntry[] {
  const byKey = new Map<string, ListEntry>();
  for (const entry of entries) {
    byKey.set(listEntryKey(entry), entry);
  }
  return [...byKey.values()];
}

export function addListEntry(lists: readonly ListEntry[], entry: ListEntry): ListEntry[] {
  const normalized = normalizeListEntry(entry);
  if (!normalized) return [...lists];
  return dedupeListEntries([...lists, normalized]);
}

export function removeListEntry(
  lists: readonly ListEntry[],
  entry: Pick<ListEntry, "pattern" | "storeId">,
): ListEntry[] {
  const key = listEntryKey(entry);
  return lists.filter((item) => listEntryKey(item) !== key);
}

export function normalizeSettings(raw: unknown): Settings {
  const source = isRecord(raw) ? raw : {};
  const lists = Array.isArray(source.lists)
    ? dedupeListEntries(
        source.lists.map(normalizeListEntry).filter((e): e is ListEntry => e !== null),
      )
    : [];
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_SETTINGS.enabled,
    delaySeconds: clampDelay(source.delaySeconds),
    cleanSiteData:
      typeof source.cleanSiteData === "boolean"
        ? source.cleanSiteData
        : DEFAULT_SETTINGS.cleanSiteData,
    cleanOnStartup:
      typeof source.cleanOnStartup === "boolean"
        ? source.cleanOnStartup
        : DEFAULT_SETTINGS.cleanOnStartup,
    notifications:
      typeof source.notifications === "boolean"
        ? source.notifications
        : DEFAULT_SETTINGS.notifications,
    lists,
  };
}

export function isCleanupTrigger(value: unknown): value is CleanupTrigger {
  return typeof value === "string" && (TRIGGERS as readonly string[]).includes(value);
}

/** Prepend `entry` to the log (newest first) and cap the length. */
export function appendActivity(
  log: readonly ActivityEntry[],
  entry: ActivityEntry,
  cap = ACTIVITY_LOG_CAP,
): ActivityEntry[] {
  return [entry, ...log].slice(0, Math.max(0, cap));
}

export function createActivityId(now = Date.now()): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Read settings from storage and coerce them into a complete object. */
export async function loadSettings(): Promise<Settings> {
  return normalizeSettings(await settingsKey.get());
}

export async function saveSettings(next: Settings): Promise<void> {
  await settingsKey.set(normalizeSettings(next));
}

export async function updateSettings(fn: (current: Settings) => Settings): Promise<Settings> {
  const next = normalizeSettings(fn(await loadSettings()));
  await settingsKey.set(next);
  return next;
}

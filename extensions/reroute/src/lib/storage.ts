/**
 * Typed storage items shared by the background, popup and options page.
 * `browser.storage.local` is the source of truth; Pro sync mirrors `rules`.
 */

import { storage } from "wxt/utils/storage";
import type { LogEntry } from "./log";
import type { Rule } from "./rules/model";

export interface Settings {
  /** Static tracking-parameter ruleset enabled. */
  trackingEnabled: boolean;
  /** Pro: mirror rules to storage.sync. */
  syncEnabled: boolean;
}

export const DEFAULT_SETTINGS: Settings = { trackingEnabled: true, syncEnabled: false };

export const rulesItem = storage.defineItem<Rule[]>("local:rules", { fallback: [] });
export const allowlistItem = storage.defineItem<string[]>("local:allowlist", { fallback: [] });
export const settingsItem = storage.defineItem<Settings>("local:settings", {
  fallback: DEFAULT_SETTINGS,
});
export const logItem = storage.defineItem<LogEntry[]>("local:log", { fallback: [] });

export async function getSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await settingsItem.getValue()) };
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await settingsItem.setValue(next);
  return next;
}

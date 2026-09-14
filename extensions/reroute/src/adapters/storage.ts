/**
 * Typed storage items shared by the background, popup and options page.
 * `browser.storage.local` is the source of truth; Pro sync mirrors `rules`.
 */

import { storage } from "wxt/utils/storage";
import type { LogEntry } from "../lib/log";
import type { Rule } from "../lib/rules/model";
import { DEFAULT_SETTINGS, type Settings } from "../lib/settings";

export const rulesItem = storage.defineItem<Rule[]>("local:rules", { fallback: [] });
export const allowlistItem = storage.defineItem<string[]>("local:allowlist", { fallback: [] });
export const settingsItem = storage.defineItem<Settings>("local:settings", {
  fallback: { ...DEFAULT_SETTINGS },
});
export const logItem = storage.defineItem<LogEntry[]>("local:log", { fallback: [] });

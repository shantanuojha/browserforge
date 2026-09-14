/**
 * Storage for settings, the activity log and the remembered cookie stores. These keys are the
 * only storage access points; everything else works on the values they return.
 */
import { defineStorageKey } from "@browserforge/shared";
import {
  ACTIVITY_STORAGE_KEY,
  DEFAULT_SETTINGS,
  KNOWN_STORES_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  normalizeSettings,
  type ActivityEntry,
  type Settings,
} from "../lib/settings.js";

export const settingsKey = defineStorageKey<Settings>(SETTINGS_STORAGE_KEY, {
  ...DEFAULT_SETTINGS,
  lists: [],
});
export const activityLogKey = defineStorageKey<ActivityEntry[]>(ACTIVITY_STORAGE_KEY, []);
/**
 * Cookie store ids seen in `cookies.getAllCookieStores()`. Firefox (and Chrome for incognito)
 * only list stores that currently have a tab, so a container vanishes from the list exactly
 * when its last tab closes; remembering it lets the cleanup still reach its cookies.
 */
export const knownStoresKey = defineStorageKey<string[]>(KNOWN_STORES_STORAGE_KEY, []);

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

/** First install writes the defaults; upgrades migrate partial/older objects to the full schema. */
export async function seedDefaultSettings(): Promise<void> {
  const stored = await settingsKey.area.get<unknown>(SETTINGS_STORAGE_KEY);
  await settingsKey.set(
    stored === undefined ? { ...DEFAULT_SETTINGS, lists: [] } : normalizeSettings(stored),
  );
}

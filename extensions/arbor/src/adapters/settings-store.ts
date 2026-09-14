/** `Settings` persisted in `browser.storage.local`; every read passes through `normalizeSettings`. */
import { browser } from "wxt/browser";
import type { SettingsStore } from "../lib/background/ports";
import { normalizeSettings, SETTINGS_KEY, type Settings } from "../lib/settings";

export async function loadSettings(): Promise<Settings> {
  const result = await browser.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(result[SETTINGS_KEY]);
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  const normalized = normalizeSettings(settings);
  await browser.storage.local.set({ [SETTINGS_KEY]: normalized });
  return normalized;
}

export function watchSettings(callback: (settings: Settings) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== "local") return;
    const change = changes[SETTINGS_KEY];
    if (change) callback(normalizeSettings(change.newValue));
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

export const browserSettingsStore: SettingsStore = { load: loadSettings, watch: watchSettings };

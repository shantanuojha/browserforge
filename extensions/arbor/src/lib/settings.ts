import { browser } from "wxt/browser";

export type ThemeMode = "system" | "light" | "dark";

export interface Settings {
  /** Minutes between time-based compactions of the op log (op-count trigger is always 200). */
  compactionIntervalMinutes: number;
  confirmCloseAll: boolean;
  theme: ThemeMode;
  backups: {
    /** Pro: scheduled local backups. */
    enabled: boolean;
    intervalMinutes: number;
    retention: number;
    /** Pro: placeholder toggle; requests the optional `identity` permission. Upload not implemented. */
    driveEnabled: boolean;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  compactionIntervalMinutes: 5,
  confirmCloseAll: true,
  theme: "system",
  backups: { enabled: false, intervalMinutes: 60, retention: 10, driveEnabled: false },
};

export const SETTINGS_KEY = "arbor:settings";

const clamp = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.min(max, Math.max(min, Math.round(v)))
    : fallback;

/** Merge unknown stored data over the defaults, ignoring anything malformed. */
export function normalizeSettings(raw: unknown): Settings {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const b = (typeof r.backups === "object" && r.backups !== null ? r.backups : {}) as Record<
    string,
    unknown
  >;
  const d = DEFAULT_SETTINGS;
  const theme =
    r.theme === "light" || r.theme === "dark" || r.theme === "system" ? r.theme : d.theme;
  return {
    compactionIntervalMinutes: clamp(
      r.compactionIntervalMinutes,
      1,
      120,
      d.compactionIntervalMinutes,
    ),
    confirmCloseAll: typeof r.confirmCloseAll === "boolean" ? r.confirmCloseAll : d.confirmCloseAll,
    theme,
    backups: {
      enabled: typeof b.enabled === "boolean" ? b.enabled : d.backups.enabled,
      intervalMinutes: clamp(b.intervalMinutes, 5, 24 * 60, d.backups.intervalMinutes),
      retention: clamp(b.retention, 1, 100, d.backups.retention),
      driveEnabled: typeof b.driveEnabled === "boolean" ? b.driveEnabled : d.backups.driveEnabled,
    },
  };
}

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

/** Apply the theme choice to a document root (used by every extension page). */
export function applyTheme(theme: ThemeMode, root: HTMLElement = document.documentElement): void {
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

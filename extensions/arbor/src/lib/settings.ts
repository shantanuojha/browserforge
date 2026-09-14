/**
 * User settings: the shape, the defaults and the rules that turn stored data back into a valid
 * `Settings`. Reading and writing the storage area is `adapters/settings-store.ts`.
 */

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
    /** Pro (planned): Google Drive backup. Hidden while `DRIVE_BACKUP_ENABLED` is false; kept so
     *  stored settings stay forward-compatible. */
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

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

const asRecord = (v: unknown): Record<string, unknown> =>
  (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;

function themeOf(v: unknown, fallback: ThemeMode): ThemeMode {
  return v === "light" || v === "dark" || v === "system" ? v : fallback;
}

/** Merge unknown stored data over the defaults, ignoring anything malformed. */
export function normalizeSettings(raw: unknown): Settings {
  const r = asRecord(raw);
  const b = asRecord(r.backups);
  const d = DEFAULT_SETTINGS;
  return {
    compactionIntervalMinutes: clamp(
      r.compactionIntervalMinutes,
      1,
      120,
      d.compactionIntervalMinutes,
    ),
    confirmCloseAll: bool(r.confirmCloseAll, d.confirmCloseAll),
    theme: themeOf(r.theme, d.theme),
    backups: {
      enabled: bool(b.enabled, d.backups.enabled),
      intervalMinutes: clamp(b.intervalMinutes, 5, 24 * 60, d.backups.intervalMinutes),
      retention: clamp(b.retention, 1, 100, d.backups.retention),
      driveEnabled: bool(b.driveEnabled, d.backups.driveEnabled),
    },
  };
}

/** Compaction interval in milliseconds, as the store wants it. */
export function compactionIntervalMs(settings: Settings): number {
  return settings.compactionIntervalMinutes * 60_000;
}

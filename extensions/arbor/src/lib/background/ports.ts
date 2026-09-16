/**
 * Ports the background service depends on, sized for what it uses. `adapters/` implements them
 * over the browser; tests hand in in-memory versions.
 */
import type { ScheduledRun } from "../backups";
import type { Settings } from "../settings";

export interface AlarmSchedule {
  periodInMinutes?: number | undefined;
  delayInMinutes?: number | undefined;
}

export interface AlarmInfo {
  periodInMinutes?: number | undefined;
  /** Epoch ms of the next fire (`chrome.alarms.Alarm.scheduledTime`). */
  scheduledTime?: number | undefined;
}

/** The slice of `chrome.alarms` the background uses. */
export interface AlarmsPort {
  create(name: string, schedule: AlarmSchedule): Promise<void>;
  get(name: string): Promise<AlarmInfo | undefined>;
  clear(name: string): Promise<void>;
  onAlarm(listener: (name: string) => void): void;
}

export interface SettingsStore {
  load(): Promise<Settings>;
  /** Calls back with every later change; returns the unsubscribe function. */
  watch(callback: (settings: Settings) => void): () => void;
}

/** Where the outcome of the last scheduled backup tick is kept for the Options page. */
export interface BackupStatusStore {
  save(run: ScheduledRun): Promise<void>;
}

/**
 * Pro: scheduled local backups.
 *
 * The extension has no `downloads` permission, so a backup is a full export written to a
 * `BackupRepository` on a timer; the Options page lists them and lets the user save any of them
 * as a file. Retention keeps the newest N. The repository is a port (`adapters/backup-store.ts`
 * keeps it in IndexedDB); the alarm that drives the schedule is another (`AlarmsPort`).
 */
import type { Clock } from "@browserforge/shared";
import type { AlarmsPort } from "./background/ports";
import { createExport, type ArborExport } from "./io/arbor-json";
import type { Tree } from "./model";

export const BACKUP_ALARM = "arbor-scheduled-backup";

export interface BackupRecord {
  ts: number;
  nodeCount: number;
  data: ArborExport;
}

export interface BackupMeta {
  ts: number;
  nodeCount: number;
}

/** Where backups live. `list` returns the newest first. */
export interface BackupRepository {
  list(): Promise<BackupMeta[]>;
  get(ts: number): Promise<BackupRecord | undefined>;
  put(record: BackupRecord): Promise<void>;
  delete(ts: number): Promise<void>;
}

/** Keep only the newest `retention` backups (at least one). Returns how many were removed. */
export async function trimBackups(
  repository: BackupRepository,
  retention: number,
): Promise<number> {
  const all = await repository.list();
  const excess = all.slice(Math.max(1, retention));
  for (const b of excess) await repository.delete(b.ts);
  return excess.length;
}

export interface BackupSchedule {
  enabled: boolean;
  intervalMinutes: number;
  retention: number;
}

export interface BackupSchedulerDeps {
  backups: BackupRepository;
  alarms: AlarmsPort;
  getTree: () => Tree;
  clock: Clock;
}

/** Owns the alarm and writes backups; the background decides when Pro/settings allow it. */
export class BackupScheduler {
  constructor(private readonly deps: BackupSchedulerDeps) {}

  async configure(schedule: BackupSchedule, pro: boolean): Promise<void> {
    const { alarms } = this.deps;
    const active = pro && schedule.enabled;
    const existing = await alarms.get(BACKUP_ALARM);
    if (!active) {
      if (existing) await alarms.clear(BACKUP_ALARM);
      return;
    }
    if (!existing || existing.periodInMinutes !== schedule.intervalMinutes) {
      await alarms.create(BACKUP_ALARM, {
        periodInMinutes: schedule.intervalMinutes,
        delayInMinutes: schedule.intervalMinutes,
      });
    }
  }

  async runNow(retention: number): Promise<BackupMeta> {
    const data = createExport(this.deps.getTree(), this.deps.clock());
    const record: BackupRecord = { ts: data.exportedAt, nodeCount: data.nodeCount, data };
    await this.deps.backups.put(record);
    await trimBackups(this.deps.backups, retention);
    return { ts: record.ts, nodeCount: record.nodeCount };
  }
}

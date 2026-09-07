import { browser } from "wxt/browser";
import { createExport, type ArborExport } from "./io/arbor-json";
import type { Tree } from "./model";
import { openDatabase, request, STORES, withStores } from "./store/idb";

/**
 * Pro: scheduled local backups.
 *
 * The extension has no `downloads` permission, so a backup is a full export written to the
 * `backups` object store on a timer; the Options page lists them and lets the user save any of
 * them as a file. Retention keeps the newest N.
 */

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

export class BackupStore {
  private db: IDBDatabase | null = null;

  constructor(private readonly factory: IDBFactory = indexedDB) {}

  private async database(): Promise<IDBDatabase> {
    if (!this.db) this.db = await openDatabase(this.factory);
    return this.db;
  }

  async list(): Promise<BackupMeta[]> {
    const db = await this.database();
    const rows = await withStores(db, [STORES.backups], "readonly", (s) =>
      request(s(STORES.backups).getAll()),
    );
    return (rows as Partial<BackupRecord>[])
      .filter((r): r is BackupRecord => typeof r.ts === "number")
      .map((r) => ({ ts: r.ts, nodeCount: r.nodeCount ?? r.data?.nodeCount ?? 0 }))
      .sort((a, b) => b.ts - a.ts);
  }

  async get(ts: number): Promise<BackupRecord | undefined> {
    const db = await this.database();
    const row = await withStores(db, [STORES.backups], "readonly", (s) =>
      request(s(STORES.backups).get(ts)),
    );
    return row as BackupRecord | undefined;
  }

  async put(record: BackupRecord): Promise<void> {
    const db = await this.database();
    await withStores(db, [STORES.backups], "readwrite", async (s) => {
      s(STORES.backups).put(record);
    });
  }

  async delete(ts: number): Promise<void> {
    const db = await this.database();
    await withStores(db, [STORES.backups], "readwrite", async (s) => {
      s(STORES.backups).delete(ts);
    });
  }

  /** Keep only the newest `retention` backups. Returns how many were removed. */
  async trim(retention: number): Promise<number> {
    const all = await this.list();
    const excess = all.slice(Math.max(1, retention));
    for (const b of excess) await this.delete(b.ts);
    return excess.length;
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
}

export interface BackupSchedule {
  enabled: boolean;
  intervalMinutes: number;
  retention: number;
}

/** Owns the alarm and writes backups; the background decides when Pro/settings allow it. */
export class BackupScheduler {
  constructor(
    private readonly backups: BackupStore,
    private readonly getTree: () => Tree,
  ) {}

  async configure(schedule: BackupSchedule, pro: boolean): Promise<void> {
    const active = pro && schedule.enabled;
    const existing = await browser.alarms.get(BACKUP_ALARM);
    if (!active) {
      if (existing) await browser.alarms.clear(BACKUP_ALARM);
      return;
    }
    if (!existing || existing.periodInMinutes !== schedule.intervalMinutes) {
      await browser.alarms.create(BACKUP_ALARM, {
        periodInMinutes: schedule.intervalMinutes,
        delayInMinutes: schedule.intervalMinutes,
      });
    }
  }

  async runNow(retention: number): Promise<BackupMeta> {
    const data = createExport(this.getTree());
    const record: BackupRecord = { ts: data.exportedAt, nodeCount: data.nodeCount, data };
    await this.backups.put(record);
    await this.backups.trim(retention);
    return { ts: record.ts, nodeCount: record.nodeCount };
  }
}

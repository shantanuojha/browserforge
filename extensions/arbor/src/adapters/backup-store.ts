/** `BackupRepository` over the `backups` object store of Arbor's IndexedDB database. */
import type { BackupMeta, BackupRecord, BackupRepository } from "../lib/backups";
import { openDatabase, request, STORES, withStores } from "./idb";

export class IndexedDbBackupStore implements BackupRepository {
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

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
}

import type { Op, Snapshot } from "../model";
import { LogTreeStore } from "./engine";
import { openDatabase, request, STORES, withStores } from "./idb";
import type { LogBackend, LogStoreOptions, QuarantinedOp, SnapshotMeta } from "./types";

interface QuarantineRecord extends QuarantinedOp {
  seq: number;
}

/**
 * IndexedDB backend: `ops` (append-only, keyed by seq), `snapshots` (full node lists) plus a
 * light `snapshotMeta` store so the Recovery screen can list snapshots without loading them.
 */
export class IndexedDbLogBackend implements LogBackend {
  private db: IDBDatabase | null = null;

  constructor(private readonly factory: IDBFactory = indexedDB) {}

  private async database(): Promise<IDBDatabase> {
    if (!this.db) this.db = await openDatabase(this.factory);
    return this.db;
  }

  async listSnapshotMeta(): Promise<SnapshotMeta[]> {
    const db = await this.database();
    const rows = await withStores(db, [STORES.snapshotMeta], "readonly", (s) =>
      request(s(STORES.snapshotMeta).getAll()),
    );
    const out: SnapshotMeta[] = [];
    for (const raw of rows as unknown[]) {
      const r = raw as Partial<SnapshotMeta>;
      if (typeof r.seq !== "number") continue;
      out.push({
        seq: r.seq,
        ts: typeof r.ts === "number" ? r.ts : 0,
        nodeCount: typeof r.nodeCount === "number" ? r.nodeCount : 0,
      });
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  async getSnapshot(seq: number): Promise<unknown> {
    const db = await this.database();
    return withStores(db, [STORES.snapshots], "readonly", (s) =>
      request(s(STORES.snapshots).get(seq)),
    );
  }

  async putSnapshot(snapshot: Snapshot): Promise<void> {
    const db = await this.database();
    const meta: SnapshotMeta = {
      seq: snapshot.seq,
      ts: snapshot.ts,
      nodeCount: snapshot.nodeCount,
    };
    await withStores(db, [STORES.snapshots, STORES.snapshotMeta], "readwrite", async (s) => {
      s(STORES.snapshots).put(snapshot);
      s(STORES.snapshotMeta).put(meta);
    });
  }

  async deleteSnapshot(seq: number): Promise<void> {
    const db = await this.database();
    await withStores(db, [STORES.snapshots, STORES.snapshotMeta], "readwrite", async (s) => {
      s(STORES.snapshots).delete(seq);
      s(STORES.snapshotMeta).delete(seq);
    });
  }

  async readOpsAfter(afterSeq: number): Promise<unknown[]> {
    const db = await this.database();
    const rows = await withStores(db, [STORES.ops], "readonly", (s) =>
      request(s(STORES.ops).getAll(IDBKeyRange.lowerBound(afterSeq, true))),
    );
    return rows as unknown[];
  }

  async appendOps(ops: readonly Op[]): Promise<void> {
    if (!ops.length) return;
    const db = await this.database();
    await withStores(db, [STORES.ops], "readwrite", async (s) => {
      const store = s(STORES.ops);
      for (const op of ops) store.put(op);
    });
  }

  async deleteOpsThrough(seq: number): Promise<void> {
    const db = await this.database();
    await withStores(db, [STORES.ops], "readwrite", async (s) => {
      s(STORES.ops).delete(IDBKeyRange.upperBound(seq));
    });
  }

  async deleteOps(seqs: readonly number[]): Promise<void> {
    if (!seqs.length) return;
    const db = await this.database();
    await withStores(db, [STORES.ops], "readwrite", async (s) => {
      const store = s(STORES.ops);
      for (const seq of seqs) store.delete(seq);
    });
  }

  async addQuarantine(items: readonly QuarantinedOp[]): Promise<void> {
    if (!items.length) return;
    const db = await this.database();
    await withStores(db, [STORES.quarantine], "readwrite", async (s) => {
      const store = s(STORES.quarantine);
      for (const item of items) {
        const record: QuarantineRecord = { ...item, seq: item.op.seq };
        store.put(record);
      }
    });
  }

  async listQuarantine(): Promise<QuarantinedOp[]> {
    const db = await this.database();
    const rows = await withStores(db, [STORES.quarantine], "readonly", (s) =>
      request(s(STORES.quarantine).getAll()),
    );
    return (rows as QuarantineRecord[]).map(({ op, reason, ts }) => ({ op, reason, ts }));
  }

  async maxSeq(): Promise<number> {
    const db = await this.database();
    const lastKey = async (name: typeof STORES.ops | typeof STORES.snapshotMeta | "quarantine") => {
      const keys = await withStores(db, [name], "readonly", (s) => request(s(name).getAllKeys()));
      let max = 0;
      for (const k of keys) if (typeof k === "number" && k > max) max = k;
      return max;
    };
    return Math.max(
      await lastKey(STORES.ops),
      await lastKey(STORES.snapshotMeta),
      await lastKey(STORES.quarantine),
    );
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
}

export class IndexedDbTreeStore extends LogTreeStore {
  constructor(options: LogStoreOptions = {}, factory: IDBFactory = indexedDB) {
    super(new IndexedDbLogBackend(factory), options);
  }
}

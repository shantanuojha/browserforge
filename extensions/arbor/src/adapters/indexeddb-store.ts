/**
 * IndexedDB backend for the op log: `ops` (append-only, keyed by seq), `snapshots` (full node
 * lists) plus a light `snapshotMeta` store so the Recovery screen can list snapshots without
 * loading them. Dumb by design: the engine (`lib/store/engine.ts`) owns every decision.
 */
import type { Op, Snapshot } from "../lib/model";
import { LogTreeStore } from "../lib/store/engine";
import type { LogBackend, LogStoreOptions, QuarantinedOp, SnapshotMeta } from "../lib/store/types";
import { openDatabase, request, STORES, withStores, type StoreName } from "./idb";

interface QuarantineRecord extends QuarantinedOp {
  seq: number;
}

function toSnapshotMeta(raw: unknown): SnapshotMeta | undefined {
  const r = raw as Partial<SnapshotMeta>;
  if (typeof r.seq !== "number") return undefined;
  return {
    seq: r.seq,
    ts: typeof r.ts === "number" ? r.ts : 0,
    nodeCount: typeof r.nodeCount === "number" ? r.nodeCount : 0,
  };
}

export class IndexedDbLogBackend implements LogBackend {
  private db: IDBDatabase | null = null;

  constructor(private readonly factory: IDBFactory = indexedDB) {}

  private async database(): Promise<IDBDatabase> {
    if (!this.db) this.db = await openDatabase(this.factory);
    return this.db;
  }

  private async read<T>(name: StoreName, run: (store: IDBObjectStore) => IDBRequest<T>) {
    const db = await this.database();
    return withStores(db, [name], "readonly", (s) => request(run(s(name))));
  }

  private async write(
    names: readonly StoreName[],
    run: (store: (name: StoreName) => IDBObjectStore) => void,
  ): Promise<void> {
    const db = await this.database();
    await withStores(db, names, "readwrite", async (s) => run(s));
  }

  async listSnapshotMeta(): Promise<SnapshotMeta[]> {
    const rows = await this.read(STORES.snapshotMeta, (s) => s.getAll());
    const out: SnapshotMeta[] = [];
    for (const raw of rows as unknown[]) {
      const meta = toSnapshotMeta(raw);
      if (meta) out.push(meta);
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  getSnapshot(seq: number): Promise<unknown> {
    return this.read(STORES.snapshots, (s) => s.get(seq));
  }

  putSnapshot(snapshot: Snapshot): Promise<void> {
    const meta: SnapshotMeta = {
      seq: snapshot.seq,
      ts: snapshot.ts,
      nodeCount: snapshot.nodeCount,
    };
    return this.write([STORES.snapshots, STORES.snapshotMeta], (s) => {
      s(STORES.snapshots).put(snapshot);
      s(STORES.snapshotMeta).put(meta);
    });
  }

  deleteSnapshot(seq: number): Promise<void> {
    return this.write([STORES.snapshots, STORES.snapshotMeta], (s) => {
      s(STORES.snapshots).delete(seq);
      s(STORES.snapshotMeta).delete(seq);
    });
  }

  async readOpsAfter(afterSeq: number): Promise<unknown[]> {
    const rows = await this.read(STORES.ops, (s) =>
      s.getAll(IDBKeyRange.lowerBound(afterSeq, true)),
    );
    return rows as unknown[];
  }

  async appendOps(ops: readonly Op[]): Promise<void> {
    if (!ops.length) return;
    await this.write([STORES.ops], (s) => {
      const store = s(STORES.ops);
      for (const op of ops) store.put(op);
    });
  }

  deleteOpsThrough(seq: number): Promise<void> {
    return this.write([STORES.ops], (s) => {
      s(STORES.ops).delete(IDBKeyRange.upperBound(seq));
    });
  }

  async deleteOps(seqs: readonly number[]): Promise<void> {
    if (!seqs.length) return;
    await this.write([STORES.ops], (s) => {
      const store = s(STORES.ops);
      for (const seq of seqs) store.delete(seq);
    });
  }

  async addQuarantine(items: readonly QuarantinedOp[]): Promise<void> {
    if (!items.length) return;
    await this.write([STORES.quarantine], (s) => {
      const store = s(STORES.quarantine);
      for (const item of items) {
        const record: QuarantineRecord = { ...item, seq: item.op.seq };
        store.put(record);
      }
    });
  }

  async listQuarantine(): Promise<QuarantinedOp[]> {
    const rows = await this.read(STORES.quarantine, (s) => s.getAll());
    return (rows as QuarantineRecord[]).map(({ op, reason, ts }) => ({ op, reason, ts }));
  }

  async maxSeq(): Promise<number> {
    const lastKey = async (name: StoreName) => {
      const keys = await this.read(name, (s) => s.getAllKeys());
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
  constructor(options: LogStoreOptions, factory: IDBFactory = indexedDB) {
    super(new IndexedDbLogBackend(factory), options);
  }
}

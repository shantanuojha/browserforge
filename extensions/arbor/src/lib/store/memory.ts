import type { Op, Snapshot } from "../model";
import { LogTreeStore } from "./engine";
import type { LogBackend, LogStoreOptions, QuarantinedOp, SnapshotMeta } from "./types";

/**
 * In-memory backend. Records are stored as structured clones (JSON round-trip) so tests exercise
 * the same coercion paths as IndexedDB. The maps are exposed so tests can corrupt them on purpose.
 */
export class MemoryLogBackend implements LogBackend {
  readonly ops = new Map<number, unknown>();
  readonly snapshots = new Map<number, unknown>();
  readonly quarantine: QuarantinedOp[] = [];
  /** When set, the next write throws (simulates a failing disk). */
  failNextWrite: Error | null = null;

  private clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T;
  }

  private maybeFail(): void {
    if (this.failNextWrite) {
      const e = this.failNextWrite;
      this.failNextWrite = null;
      throw e;
    }
  }

  async listSnapshotMeta(): Promise<SnapshotMeta[]> {
    const out: SnapshotMeta[] = [];
    for (const [seq, raw] of this.snapshots) {
      const s = raw as Partial<Snapshot>;
      out.push({
        seq,
        ts: typeof s.ts === "number" ? s.ts : 0,
        nodeCount: typeof s.nodeCount === "number" ? s.nodeCount : 0,
      });
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  async getSnapshot(seq: number): Promise<unknown> {
    const s = this.snapshots.get(seq);
    return s === undefined ? undefined : this.clone(s);
  }

  async putSnapshot(snapshot: Snapshot): Promise<void> {
    this.maybeFail();
    this.snapshots.set(snapshot.seq, this.clone(snapshot));
  }

  async deleteSnapshot(seq: number): Promise<void> {
    this.snapshots.delete(seq);
  }

  async readOpsAfter(afterSeq: number): Promise<unknown[]> {
    return [...this.ops.entries()]
      .filter(([seq]) => seq > afterSeq)
      .sort((a, b) => a[0] - b[0])
      .map(([, raw]) => this.clone(raw));
  }

  async appendOps(ops: readonly Op[]): Promise<void> {
    this.maybeFail();
    for (const op of ops) this.ops.set(op.seq, this.clone(op));
  }

  async deleteOpsThrough(seq: number): Promise<void> {
    for (const k of [...this.ops.keys()]) if (k <= seq) this.ops.delete(k);
  }

  async deleteOps(seqs: readonly number[]): Promise<void> {
    for (const s of seqs) this.ops.delete(s);
  }

  async addQuarantine(items: readonly QuarantinedOp[]): Promise<void> {
    this.quarantine.push(...items.map((i) => this.clone(i)));
  }

  async listQuarantine(): Promise<QuarantinedOp[]> {
    return this.quarantine.map((i) => this.clone(i));
  }

  async maxSeq(): Promise<number> {
    let max = 0;
    for (const k of this.ops.keys()) max = Math.max(max, k);
    for (const k of this.snapshots.keys()) max = Math.max(max, k);
    for (const q of this.quarantine) max = Math.max(max, q.op.seq);
    return max;
  }

  async close(): Promise<void> {
    // nothing to release
  }
}

export class MemoryTreeStore extends LogTreeStore {
  constructor(
    readonly memory: MemoryLogBackend = new MemoryLogBackend(),
    options: LogStoreOptions = {},
  ) {
    super(memory, { flushDelayMs: 0, ...options });
  }
}

import {
  applyOp,
  applyOps,
  coerceNode,
  coerceOp,
  createTree,
  serializeNodes,
  validateTree,
  type Op,
  type OpBody,
  type Snapshot,
  type Tree,
  type TreeNode,
} from "../model";
import type {
  LogBackend,
  LogStoreOptions,
  OpenReport,
  QuarantinedOp,
  SnapshotMeta,
  TreeListener,
  TreeStore,
} from "./types";

const DEFAULTS: Required<LogStoreOptions> = {
  compactEveryOps: 200,
  compactIntervalMs: 5 * 60_000,
  snapshotRetention: 30,
  flushDelayMs: 250,
  now: () => Date.now(),
};

/** Parse a raw snapshot record; returns undefined when unusable. */
export function coerceSnapshot(value: unknown): Snapshot | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.seq !== "number" || !Array.isArray(v.nodes)) return undefined;
  const nodes: TreeNode[] = [];
  for (const raw of v.nodes) {
    const n = coerceNode(raw);
    if (!n) return undefined;
    nodes.push(n);
  }
  return {
    seq: v.seq,
    ts: typeof v.ts === "number" ? v.ts : 0,
    nodes,
    nodeCount: nodes.length,
  };
}

/**
 * Append-only op log + compacted snapshots on top of a `LogBackend`.
 *
 * Writes are serialised through a single promise queue so compaction never races an op flush.
 */
export class LogTreeStore implements TreeStore {
  private tree: Tree = createTree();
  private nextSeq = 1;
  private lastSnapshotSeq = 0;
  private lastSnapshotTs = 0;
  private opsSinceSnapshot = 0;
  private pending: Op[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<TreeListener>();
  private opened = false;
  private closed = false;
  private readonly opts: Required<LogStoreOptions>;

  constructor(
    private readonly backend: LogBackend,
    options: LogStoreOptions = {},
  ) {
    this.opts = { ...DEFAULTS, ...options };
  }

  // -- lifecycle -----------------------------------------------------------------------------

  async open(): Promise<OpenReport> {
    const report: OpenReport = {
      snapshotSeq: 0,
      replayed: 0,
      quarantined: 0,
      skippedSnapshots: 0,
      warnings: [],
    };

    // 1. Newest valid snapshot.
    const metas = (await this.backend.listSnapshotMeta()).sort((a, b) => b.seq - a.seq);
    let base: Snapshot | undefined;
    for (const meta of metas) {
      const snap = coerceSnapshot(await this.backend.getSnapshot(meta.seq));
      if (!snap) {
        report.skippedSnapshots++;
        report.warnings.push(`snapshot ${meta.seq} is unreadable`);
        continue;
      }
      const problems = validateTree(createTree(snap.nodes));
      if (problems.length) {
        report.skippedSnapshots++;
        report.warnings.push(`snapshot ${meta.seq} is inconsistent: ${problems[0]}`);
        continue;
      }
      base = snap;
      break;
    }

    let tree = createTree(base?.nodes ?? []);
    this.lastSnapshotSeq = base?.seq ?? 0;
    this.lastSnapshotTs = base?.ts ?? this.opts.now();
    report.snapshotSeq = this.lastSnapshotSeq;

    // 2. Replay the log after the snapshot; quarantine anything that does not apply.
    const rawOps = await this.backend.readOpsAfter(this.lastSnapshotSeq);
    const bad: QuarantinedOp[] = [];
    const badSeqs: number[] = [];
    let maxSeq = this.lastSnapshotSeq;
    for (const raw of rawOps) {
      const op = coerceOp(raw);
      if (!op) {
        const seq = (raw as { seq?: unknown } | null)?.seq;
        if (typeof seq === "number") badSeqs.push(seq);
        report.warnings.push("dropped an unreadable op record");
        continue;
      }
      maxSeq = Math.max(maxSeq, op.seq);
      try {
        tree = applyOp(tree, op, op.ts);
        report.replayed++;
      } catch (e) {
        bad.push({ op, reason: e instanceof Error ? e.message : String(e), ts: this.opts.now() });
        badSeqs.push(op.seq);
      }
    }
    report.quarantined = bad.length;

    this.tree = tree;
    this.nextSeq = Math.max(maxSeq, await this.backend.maxSeq()) + 1;
    this.opsSinceSnapshot = report.replayed;
    this.opened = true;

    // 3. Repair: move bad ops out of the log and pin the good state in a fresh snapshot.
    if (badSeqs.length) {
      await this.enqueue(async () => {
        if (bad.length) await this.backend.addQuarantine(bad);
        await this.backend.deleteOps(badSeqs);
      });
      await this.compact(true);
    }
    return report;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
    await this.backend.close();
  }

  getTree(): Tree {
    return this.tree;
  }

  subscribe(listener: TreeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(ops: readonly Op[] | null): void {
    for (const l of this.listeners) {
      try {
        l(this.tree, ops);
      } catch (e) {
        console.error("[arbor:store] listener failed", e);
      }
    }
  }

  // -- writes --------------------------------------------------------------------------------

  append(bodies: readonly OpBody[]): Op[] {
    this.assertOpen();
    if (bodies.length === 0) return [];
    const ts = this.opts.now();
    const ops: Op[] = bodies.map((b) => ({ ...b, seq: this.nextSeq++, ts }));
    try {
      this.tree = applyOps(this.tree, ops);
    } catch (e) {
      this.nextSeq -= ops.length; // nothing was applied; do not burn sequence numbers
      throw e;
    }
    this.pending.push(...ops);
    this.opsSinceSnapshot += ops.length;
    this.scheduleFlush();
    this.notify(ops);
    if (this.opsSinceSnapshot >= this.opts.compactEveryOps) {
      void this.compact().catch((e) => console.error("[arbor:store] compaction failed", e));
    }
    return ops;
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch((e) => console.error("[arbor:store] flush failed", e));
    }, this.opts.flushDelayMs);
  }

  flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    return this.enqueue(async () => {
      if (!this.pending.length) return;
      const batch = this.pending;
      this.pending = [];
      try {
        await this.backend.appendOps(batch);
      } catch (e) {
        this.pending = [...batch, ...this.pending];
        throw e;
      }
    });
  }

  async compact(force = false): Promise<Snapshot | null> {
    this.assertOpen();
    await this.flush();
    return this.enqueue(async () => {
      if (!force && this.opsSinceSnapshot === 0) return null;
      const seq = this.nextSeq - 1;
      const nodes = serializeNodes(this.tree);
      const snapshot: Snapshot = { seq, ts: this.opts.now(), nodes, nodeCount: nodes.length };
      await this.backend.putSnapshot(snapshot);
      await this.backend.deleteOpsThrough(seq);
      this.lastSnapshotSeq = seq;
      this.lastSnapshotTs = snapshot.ts;
      this.opsSinceSnapshot = 0;
      await this.pruneSnapshots();
      return snapshot;
    });
  }

  setCompactionInterval(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.opts.compactIntervalMs = ms;
  }

  async compactIfDue(now = this.opts.now()): Promise<boolean> {
    if (this.opsSinceSnapshot === 0) return false;
    const due =
      this.opsSinceSnapshot >= this.opts.compactEveryOps ||
      now - this.lastSnapshotTs >= this.opts.compactIntervalMs;
    if (!due) return false;
    await this.compact();
    return true;
  }

  private async pruneSnapshots(): Promise<void> {
    const metas = (await this.backend.listSnapshotMeta()).sort((a, b) => b.seq - a.seq);
    for (const meta of metas.slice(this.opts.snapshotRetention)) {
      await this.backend.deleteSnapshot(meta.seq);
    }
  }

  // -- snapshots -----------------------------------------------------------------------------

  async listSnapshots(): Promise<SnapshotMeta[]> {
    const metas = await this.backend.listSnapshotMeta();
    return metas.sort((a, b) => b.seq - a.seq);
  }

  async getSnapshot(seq: number): Promise<Snapshot | undefined> {
    return coerceSnapshot(await this.backend.getSnapshot(seq));
  }

  async restoreSnapshot(seq: number): Promise<Tree> {
    this.assertOpen();
    const snap = await this.getSnapshot(seq);
    if (!snap) throw new Error(`snapshot ${seq} not found`);
    return this.replaceTree(snap.nodes);
  }

  async replaceTree(nodes: readonly TreeNode[]): Promise<Tree> {
    this.assertOpen();
    const tree = createTree(nodes);
    const problems = validateTree(tree);
    if (problems.length) throw new Error(`refusing to load inconsistent tree: ${problems[0]}`);
    // Pin the outgoing tree in its own snapshot so the replacement is always reversible.
    await this.compact();
    await this.enqueue(async () => {
      this.pending = [];
      this.tree = tree;
      const seq = this.nextSeq++;
      const serialised = serializeNodes(tree);
      const snapshot: Snapshot = {
        seq,
        ts: this.opts.now(),
        nodes: serialised,
        nodeCount: serialised.length,
      };
      await this.backend.putSnapshot(snapshot);
      await this.backend.deleteOpsThrough(seq);
      this.lastSnapshotSeq = seq;
      this.lastSnapshotTs = snapshot.ts;
      this.opsSinceSnapshot = 0;
      await this.pruneSnapshots();
    });
    this.notify(null);
    return this.tree;
  }

  listQuarantine(): Promise<QuarantinedOp[]> {
    return this.backend.listQuarantine();
  }

  // -- internals -----------------------------------------------------------------------------

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private assertOpen(): void {
    if (!this.opened) throw new Error("TreeStore.open() has not completed");
    if (this.closed) throw new Error("TreeStore is closed");
  }
}

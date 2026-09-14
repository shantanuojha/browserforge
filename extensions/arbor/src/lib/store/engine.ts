import { createLogger, errorMessage, type Logger } from "@browserforge/shared";
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

const DEFAULTS = {
  compactEveryOps: 200,
  compactIntervalMs: 5 * 60_000,
  snapshotRetention: 30,
  flushDelayMs: 250,
};

type ResolvedOptions = Required<Omit<LogStoreOptions, "logger">> & { logger: Logger };

/** Parse a raw snapshot record; returns undefined when unusable. `now` fills missing timestamps. */
export function coerceSnapshot(value: unknown, now: number): Snapshot | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.seq !== "number" || !Array.isArray(v.nodes)) return undefined;
  const nodes: TreeNode[] = [];
  for (const raw of v.nodes) {
    const n = coerceNode(raw, now);
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

/** Outcome of replaying the op log on top of a snapshot. */
interface Replay {
  tree: Tree;
  maxSeq: number;
  replayed: number;
  /** Ops that did not apply, kept for inspection. */
  bad: QuarantinedOp[];
  /** Sequence numbers to remove from the log: the quarantined ops and unreadable records. */
  badSeqs: number[];
  warnings: string[];
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
  private readonly opts: ResolvedOptions;

  constructor(
    private readonly backend: LogBackend,
    options: LogStoreOptions,
  ) {
    this.opts = { ...DEFAULTS, logger: createLogger("arbor:store"), ...options };
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
    const base = await this.newestValidSnapshot(report);
    this.lastSnapshotSeq = base?.seq ?? 0;
    this.lastSnapshotTs = base?.ts ?? this.opts.now();
    report.snapshotSeq = this.lastSnapshotSeq;

    const replay = this.replay(
      createTree(base?.nodes ?? []),
      await this.backend.readOpsAfter(this.lastSnapshotSeq),
    );
    report.replayed = replay.replayed;
    report.quarantined = replay.bad.length;
    report.warnings.push(...replay.warnings);

    this.tree = replay.tree;
    this.nextSeq = Math.max(replay.maxSeq, await this.backend.maxSeq()) + 1;
    this.opsSinceSnapshot = replay.replayed;
    this.opened = true;

    if (replay.badSeqs.length) await this.repair(replay);
    return report;
  }

  /** Newest snapshot that parses and describes a consistent tree; unusable ones are reported. */
  private async newestValidSnapshot(report: OpenReport): Promise<Snapshot | undefined> {
    const metas = (await this.backend.listSnapshotMeta()).sort((a, b) => b.seq - a.seq);
    for (const meta of metas) {
      const snap = coerceSnapshot(await this.backend.getSnapshot(meta.seq), this.opts.now());
      const problem = snap ? validateTree(createTree(snap.nodes))[0] : undefined;
      if (snap && problem === undefined) return snap;
      report.skippedSnapshots++;
      report.warnings.push(
        snap
          ? `snapshot ${meta.seq} is inconsistent: ${problem}`
          : `snapshot ${meta.seq} is unreadable`,
      );
    }
    return undefined;
  }

  /** Replay the log after the snapshot; anything that does not apply is set aside. */
  private replay(base: Tree, rawOps: readonly unknown[]): Replay {
    const result: Replay = {
      tree: base,
      maxSeq: this.lastSnapshotSeq,
      replayed: 0,
      bad: [],
      badSeqs: [],
      warnings: [],
    };
    for (const raw of rawOps) {
      const op = coerceOp(raw, this.opts.now());
      if (!op) {
        const seq = (raw as { seq?: unknown } | null)?.seq;
        if (typeof seq === "number") result.badSeqs.push(seq);
        result.warnings.push("dropped an unreadable op record");
        continue;
      }
      result.maxSeq = Math.max(result.maxSeq, op.seq);
      try {
        result.tree = applyOp(result.tree, op, op.ts);
        result.replayed++;
      } catch (e) {
        result.bad.push({ op, reason: errorMessage(e), ts: this.opts.now() });
        result.badSeqs.push(op.seq);
      }
    }
    return result;
  }

  /** Move bad ops out of the log and pin the good state in a fresh snapshot. */
  private async repair(replay: Replay): Promise<void> {
    await this.enqueue(async () => {
      if (replay.bad.length) await this.backend.addQuarantine(replay.bad);
      await this.backend.deleteOps(replay.badSeqs);
    });
    await this.compact(true);
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
        this.opts.logger.error("listener failed", e);
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
      this.tree = applyOps(this.tree, ops, ts);
    } catch (e) {
      this.nextSeq -= ops.length; // nothing was applied; do not burn sequence numbers
      throw e;
    }
    this.pending.push(...ops);
    this.opsSinceSnapshot += ops.length;
    this.scheduleFlush();
    this.notify(ops);
    if (this.opsSinceSnapshot >= this.opts.compactEveryOps) {
      void this.compact().catch((e) => this.opts.logger.error("compaction failed", e));
    }
    return ops;
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch((e) => this.opts.logger.error("flush failed", e));
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
      const covered = this.opsSinceSnapshot;
      const snapshot = await this.pinSnapshot(this.nextSeq - 1);
      // Ops appended while the snapshot was being written (append is synchronous) are not in it
      // and stay pending, so the next compaction or replaceTree still pins them.
      this.opsSinceSnapshot -= covered;
      await this.pruneSnapshots();
      return snapshot;
    });
  }

  /** Persist the current tree as snapshot `seq` and drop the log it covers. */
  private async pinSnapshot(seq: number): Promise<Snapshot> {
    const nodes = serializeNodes(this.tree);
    const snapshot: Snapshot = { seq, ts: this.opts.now(), nodes, nodeCount: nodes.length };
    await this.backend.putSnapshot(snapshot);
    await this.backend.deleteOpsThrough(seq);
    this.lastSnapshotSeq = seq;
    this.lastSnapshotTs = snapshot.ts;
    return snapshot;
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
    return coerceSnapshot(await this.backend.getSnapshot(seq), this.opts.now());
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
      await this.pinSnapshot(this.nextSeq++);
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

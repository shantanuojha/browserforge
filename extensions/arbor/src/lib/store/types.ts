import type { Op, OpBody, Snapshot, Tree, TreeNode } from "../model";

export interface SnapshotMeta {
  seq: number;
  ts: number;
  nodeCount: number;
}

export interface QuarantinedOp {
  op: Op;
  reason: string;
  ts: number;
}

export interface OpenReport {
  /** Sequence number of the snapshot the tree was loaded from (0 when starting empty). */
  snapshotSeq: number;
  /** Ops replayed successfully on top of the snapshot. */
  replayed: number;
  /** Ops that failed to replay and were moved to quarantine. */
  quarantined: number;
  /** Snapshots that were skipped because they failed validation. */
  skippedSnapshots: number;
  warnings: string[];
}

export type TreeListener = (tree: Tree, ops: readonly Op[] | null) => void;

/**
 * Persistence contract for the tree. Implementations are an append-only op log plus periodic
 * compacted snapshots; see `LogTreeStore` for the shared logic and `MemoryTreeStore` /
 * `IndexedDbTreeStore` for the backends.
 */
export interface TreeStore {
  open(): Promise<OpenReport>;
  getTree(): Tree;
  /**
   * Validate and apply ops to the in-memory tree synchronously; persistence is debounced.
   * Throws `OpError` (and applies nothing) when any op is invalid.
   */
  append(bodies: readonly OpBody[]): Op[];
  /** Write any pending ops to the backend. */
  flush(): Promise<void>;
  /** Write a snapshot of the current tree and truncate the log. No-op unless ops are pending or `force`. */
  compact(force?: boolean): Promise<Snapshot | null>;
  /** Compact when the op-count or time thresholds have been reached. */
  compactIfDue(now?: number): Promise<boolean>;
  setCompactionInterval(ms: number): void;
  listSnapshots(): Promise<SnapshotMeta[]>;
  getSnapshot(seq: number): Promise<Snapshot | undefined>;
  /** Make a previous snapshot the current tree (non-destructive: writes a new snapshot). */
  restoreSnapshot(seq: number): Promise<Tree>;
  /** Replace the whole tree (used by "replace" imports). Writes a snapshot. */
  replaceTree(nodes: readonly TreeNode[]): Promise<Tree>;
  listQuarantine(): Promise<QuarantinedOp[]>;
  subscribe(listener: TreeListener): () => void;
  close(): Promise<void>;
}

/** Low-level storage primitives a `LogTreeStore` needs. Keep it dumb; logic lives in the engine. */
export interface LogBackend {
  listSnapshotMeta(): Promise<SnapshotMeta[]>;
  getSnapshot(seq: number): Promise<unknown>;
  putSnapshot(snapshot: Snapshot): Promise<void>;
  deleteSnapshot(seq: number): Promise<void>;
  /** Raw records with seq > `afterSeq`, ascending. Records are untrusted (`unknown`). */
  readOpsAfter(afterSeq: number): Promise<unknown[]>;
  appendOps(ops: readonly Op[]): Promise<void>;
  deleteOpsThrough(seq: number): Promise<void>;
  deleteOps(seqs: readonly number[]): Promise<void>;
  addQuarantine(items: readonly QuarantinedOp[]): Promise<void>;
  listQuarantine(): Promise<QuarantinedOp[]>;
  /** Highest seq seen anywhere (ops, snapshots, quarantine). */
  maxSeq(): Promise<number>;
  close(): Promise<void>;
}

export interface LogStoreOptions {
  /** Compact after this many ops since the last snapshot. Default 200. */
  compactEveryOps?: number;
  /** Compact when the last snapshot is older than this and ops are pending. Default 5 min. */
  compactIntervalMs?: number;
  /** Number of snapshots to keep. Default 30. */
  snapshotRetention?: number;
  /** Debounce for writing ops to the backend. Default 250 ms; 0 writes on next tick. */
  flushDelayMs?: number;
  now?: () => number;
}

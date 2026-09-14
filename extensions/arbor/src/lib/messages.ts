/**
 * The catalog of messages between the pages and the background: names and request/response
 * types only. `adapters/messaging.ts` binds it to the runtime as `msg`.
 */
import type { BackupMeta } from "./backups";
import type { HistoryStep } from "./history";
import type { ArborExport } from "./io/arbor-json";
import { defineMessage } from "./messaging";
import type { NodeId, Op, OpBody, TreeNode } from "./model";
import type { OpenReport, QuarantinedOp, SnapshotMeta } from "./store/types";
import type { LiveState } from "./sync/tracker";
import type { RebuildReport } from "./sync/types";

/** Shape pushed to connected side panels over the `TREE_PORT` and returned by `getState`. */
export interface TreeState {
  nodes: TreeNode[];
  live: LiveState;
}

export interface StartupInfo {
  report: OpenReport | null;
  rebuild: RebuildReport | null;
  startedAt: number;
}

export const TREE_PORT = "arbor-tree";

export type TreePortMessage = { type: "tree"; state: TreeState };

export function isTreePortMessage(value: unknown): value is TreePortMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "tree" &&
    typeof (value as { state?: unknown }).state === "object"
  );
}

export const messages = {
  getState: defineMessage<void, TreeState>("getState"),
  getStartupInfo: defineMessage<void, StartupInfo>("getStartupInfo"),
  /** Generic edits from the UI: notes, titles, collapse, delete. */
  applyOps: defineMessage<OpBody[], Op[]>("applyOps"),
  /** Returns the containers pruned because the move left them empty (outermost first). */
  moveNode: defineMessage<{ id: NodeId; parentId: NodeId | null; index: number }, TreeNode[]>(
    "moveNode",
  ),
  focusNode: defineMessage<{ id: NodeId }, void>("focusNode"),
  restoreNode: defineMessage<{ id: NodeId }, void>("restoreNode"),
  /**
   * Container action: reopen a container's closed tabs (into its window when open, as a new
   * window otherwise). Returns how many tabs were opened or moved in.
   */
  reopenAll: defineMessage<{ id: NodeId }, number>("reopenAll"),
  closeAndSave: defineMessage<{ id: NodeId }, number>("closeAndSave"),
  closeAllAndSave: defineMessage<void, number>("closeAllAndSave"),
  /** Returns every node removed (subtree plus pruned containers), parents before children. */
  deleteNode: defineMessage<{ id: NodeId }, TreeNode[]>("deleteNode"),
  /** A new group (`window`, unbound) or note. */
  addNode: defineMessage<
    { parentId: NodeId | null; index?: number; kind: "window" | "note"; title: string },
    TreeNode
  >("addNode"),
  /** One undo/redo step, run through the tracker like the user action it reverses. */
  applyHistoryStep: defineMessage<HistoryStep, void>("applyHistoryStep"),

  listSnapshots: defineMessage<void, SnapshotMeta[]>("listSnapshots"),
  restoreSnapshot: defineMessage<{ seq: number }, number>("restoreSnapshot"),
  listQuarantine: defineMessage<void, QuarantinedOp[]>("listQuarantine"),
  compactNow: defineMessage<void, SnapshotMeta | null>("compactNow"),

  exportTree: defineMessage<void, ArborExport>("exportTree"),
  /** `nodes` must be ordered parents-first (see `materialize`). */
  importNodes: defineMessage<{ nodes: TreeNode[]; mode: "merge" | "replace" }, number>(
    "importNodes",
  ),

  listBackups: defineMessage<void, BackupMeta[]>("listBackups"),
  runBackupNow: defineMessage<void, BackupMeta>("runBackupNow"),
  getBackup: defineMessage<{ ts: number }, ArborExport | null>("getBackup"),
  deleteBackup: defineMessage<{ ts: number }, void>("deleteBackup"),

  openSidePanel: defineMessage<{ windowId?: number | undefined }, boolean>("openSidePanel"),
};

export type Messages = typeof messages;

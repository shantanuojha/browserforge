import type { BackupMeta } from "./backups";
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

export const msg = {
  getState: defineMessage<void, TreeState>("getState"),
  getStartupInfo: defineMessage<void, StartupInfo>("getStartupInfo"),
  /** Generic edits from the UI: notes, titles, collapse, delete. */
  applyOps: defineMessage<OpBody[], Op[]>("applyOps"),
  moveNode: defineMessage<{ id: NodeId; parentId: NodeId | null; index: number }, void>("moveNode"),
  focusNode: defineMessage<{ id: NodeId }, void>("focusNode"),
  restoreNode: defineMessage<{ id: NodeId }, void>("restoreNode"),
  /** Container action: reopen every saved tab beneath a window/group in place. Returns the count. */
  reopenAll: defineMessage<{ id: NodeId }, number>("reopenAll"),
  closeAndSave: defineMessage<{ id: NodeId }, number>("closeAndSave"),
  closeAllAndSave: defineMessage<void, number>("closeAllAndSave"),
  deleteNode: defineMessage<{ id: NodeId }, void>("deleteNode"),
  addNode: defineMessage<
    { parentId: NodeId | null; index?: number; kind: "group" | "note"; title: string },
    TreeNode
  >("addNode"),

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

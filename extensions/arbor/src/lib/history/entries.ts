/**
 * Entry builders: from "what the panel showed before the action" plus "what the background
 * reported" to a self-contained undo/redo entry with its labels.
 */
import type { Clock } from "@browserforge/shared";
import {
  containerTabs,
  displayTitle,
  isBound,
  isContainer,
  ops,
  type NodeId,
  type OpBody,
  type Tree,
  type TreeNode,
} from "../model";
import { liveTabNodesIn, readdOps, savedTabNodesIn, siblingIndex } from "./inverse";
import type { HistoryEntry, HistoryStep } from "./steps";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const quote = (node: TreeNode) => {
  const title = displayTitle(node);
  return `"${title.length > 40 ? `${title.slice(0, 39)}…` : title}"`;
};

function describeRemoved(removed: readonly TreeNode[], rootId: NodeId): string {
  const root = removed.find((n) => n.id === rootId) ?? removed[0];
  const tabs = removed.filter((n) => n.kind === "tab").length;
  if (!root) return "delete";
  if (root.kind === "tab") {
    return tabs === 1 ? `delete ${quote(root)}` : `delete ${plural(tabs, "tab")}`;
  }
  const what = root.kind === "note" ? "note" : quote(root);
  return tabs ? `delete ${what} (${plural(tabs, "tab")})` : `delete ${what}`;
}

const past = (label: string) =>
  label
    .replace(/^delete/, "Deleted")
    .replace(/^move/, "Moved")
    .replace(/^close/, "Closed and saved")
    .replace(/^reopen/, "Reopened")
    .replace(/^rename/, "Renamed")
    .replace(/^edit note/, "Edited note")
    .replace(/^new/, "Added new");

/** Label for closing or reopening `nodes` beneath `root`: the node itself when it is one tab. */
function tabsLabel(verb: string, root: TreeNode | undefined, nodes: readonly TreeNode[]): string {
  return nodes.length === 1 && root?.kind === "tab"
    ? `${verb} ${quote(root)}`
    : `${verb} ${plural(nodes.length, "tab")}`;
}

/** Nodes "Restore" / "Reopen all" opens: a container's own closed tabs, else the saved subtree. */
function reopenTargets(before: Tree, id: NodeId): TreeNode[] {
  const root = before.get(id);
  return root && isContainer(root)
    ? containerTabs(before, id).filter((n) => n.liveTabId === undefined && n.url)
    : savedTabNodesIn(before, id);
}

/** A drag / drop as the panel requested it. */
export interface MoveRequest {
  id: NodeId;
  parentId: NodeId | null;
  index: number;
}

/**
 * Each builder takes the tree *as the panel saw it before the action* (plus whatever the
 * background reported) and returns `null` when there is nothing to undo.
 */
export interface HistoryBuilders {
  rename(before: Tree, id: NodeId, title: string): HistoryEntry | null;
  note(before: Tree, id: NodeId, note: string): HistoryEntry | null;
  /** A group (unbound container) or note the user just created (response of `addNode`). */
  create(node: TreeNode, index: number | undefined): HistoryEntry;
  /** A drag / drop. `pruned` is what `moveNode` returned: windows emptied by the move. */
  move(before: Tree, move: MoveRequest, pruned?: readonly TreeNode[]): HistoryEntry | null;
  /** A delete. `removed` is what `deleteNode` returned: subtree plus pruned windows, parents first. */
  remove(before: Tree, removed: readonly TreeNode[], rootId: NodeId): HistoryEntry | null;
  /**
   * Close-and-save on a tab or container: the open tabs beneath it become saved in place. Closing
   * a bound container closes its browser window, so the undo brings that window back as one.
   */
  closeAndSave(before: Tree, id: NodeId): HistoryEntry | null;
  /**
   * Restore / Reopen all on a saved node: its saved tabs open in place. On an unbound container
   * that means opening it as a browser window; the redo does the same, the undo closes those
   * tabs again (and with them the window).
   */
  reopen(before: Tree, id: NodeId): HistoryEntry | null;
}

/** An entry before it is stamped: the label and both step lists. */
interface Draft {
  label: string;
  undo: HistoryStep[];
  redo: HistoryStep[];
}

const opsStep = (...bodies: OpBody[]): HistoryStep => ({ kind: "ops", ops: bodies });

function renameDraft(before: Tree, id: NodeId, title: string): Draft | null {
  const node = before.get(id);
  if (!node || node.title === title) return null;
  return {
    label: `rename ${quote(node)}`,
    undo: [opsStep(ops.update(id, { title: node.title }))],
    redo: [opsStep(ops.update(id, { title }))],
  };
}

function noteDraft(before: Tree, id: NodeId, note: string): Draft | null {
  const node = before.get(id);
  if (!node) return null;
  const text = note.trim();
  const old = (node.note ?? "").trim();
  if (text === old) return null;
  return {
    label: `edit note on ${quote(node)}`,
    undo: [opsStep(ops.note(id, old))],
    redo: [opsStep(ops.note(id, text))],
  };
}

function createDraft(node: TreeNode, index: number | undefined): Draft {
  return {
    label: `new ${node.kind === "window" ? "group" : node.kind}`,
    undo: [{ kind: "removeEmpty", id: node.id }],
    redo: [opsStep(ops.add(node, index))],
  };
}

function moveDraft(before: Tree, move: MoveRequest, pruned: readonly TreeNode[]): Draft | null {
  const node = before.get(move.id);
  if (!node) return null;
  const undo: HistoryStep[] = [];
  if (pruned.length) undo.push(opsStep(...readdOps(before, pruned)));
  undo.push({
    kind: "move",
    id: move.id,
    parentId: node.parentId,
    index: siblingIndex(before, node),
  });
  return { label: `move ${quote(node)}`, undo, redo: [{ kind: "move", ...move }] };
}

function removeDraft(before: Tree, removed: readonly TreeNode[], rootId: NodeId): Draft | null {
  if (!removed.length) return null;
  return {
    label: describeRemoved(removed, rootId),
    undo: [opsStep(...readdOps(before, removed))],
    redo: [{ kind: "delete", id: rootId }],
  };
}

/** `reopen` step for `ids`; with `container` they come back as that container's window. */
function reopenStep(ids: NodeId[], container: NodeId | undefined): HistoryStep {
  return container === undefined ? { kind: "reopen", ids } : { kind: "reopen", ids, container };
}

function closeAndSaveDraft(before: Tree, id: NodeId): Draft | null {
  const nodes = liveTabNodesIn(before, id);
  if (!nodes.length) return null;
  const ids = nodes.map((n) => n.id);
  const root = before.get(id);
  const asWindow = root && isBound(root) ? id : undefined;
  return {
    label: tabsLabel("close", root, nodes),
    undo: [reopenStep(ids, asWindow)],
    redo: [{ kind: "close", ids }],
  };
}

function reopenDraft(before: Tree, id: NodeId): Draft | null {
  const root = before.get(id);
  const nodes = reopenTargets(before, id);
  if (!nodes.length) return null;
  const ids = nodes.map((n) => n.id);
  const asWindow = root && isContainer(root) && !isBound(root) ? id : undefined;
  return {
    label: tabsLabel("reopen", root, nodes),
    undo: [{ kind: "close", ids }],
    redo: [reopenStep(ids, asWindow)],
  };
}

/** `entry.ts` comes from `clock` at build time; the panel passes the system clock. */
export function createHistory(clock: Clock): HistoryBuilders {
  const stamp = (draft: Draft | null): HistoryEntry | null =>
    draft && { ...draft, done: past(draft.label), ts: clock() };
  return {
    rename: (before, id, title) => stamp(renameDraft(before, id, title)),
    note: (before, id, note) => stamp(noteDraft(before, id, note)),
    create: (node, index) => stamp(createDraft(node, index)) as HistoryEntry,
    move: (before, move, pruned = []) => stamp(moveDraft(before, move, pruned)),
    remove: (before, removed, rootId) => stamp(removeDraft(before, removed, rootId)),
    closeAndSave: (before, id) => stamp(closeAndSaveDraft(before, id)),
    reopen: (before, id) => stamp(reopenDraft(before, id)),
  };
}

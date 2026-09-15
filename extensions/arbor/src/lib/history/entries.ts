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
import { plural, summarizeRemoval, withDetail } from "../removal";
import { liveTabNodesIn, readdOps, savedTabNodesIn, siblingIndex, unremoveOps } from "./inverse";
import type { HistoryEntry, HistoryStep } from "./steps";

const quote = (node: TreeNode) => {
  const title = displayTitle(node);
  return `"${title.length > 40 ? `${title.slice(0, 39)}…` : title}"`;
};

/** How an entry names the node it acted on: its quoted title, or just "note". */
const nameOf = (root: TreeNode) => (root.kind === "note" ? "note" : quote(root));

/** Tab nodes among `removed` other than the root itself, which the label already names. */
const removedTabsBesides = (removed: readonly TreeNode[], rootId: NodeId) =>
  removed.filter((n) => n.kind === "tab" && n.id !== rootId);

/** "remove "G" (3 saved tabs, 2 open tabs kept)"; on an open window, "remove saved items from". */
function describeRemove(before: Tree, removed: readonly TreeNode[], root: TreeNode): string {
  const saved = removedTabsBesides(removed, root.id).length;
  const kept = liveTabNodesIn(before, root.id).length;
  const what = isBound(root) ? `remove saved items from ${quote(root)}` : `remove ${nameOf(root)}`;
  return withDetail(
    what,
    [saved ? plural(saved, "saved tab") : "", kept ? `${plural(kept, "open tab")} kept` : ""]
      .filter(Boolean)
      .join(", "),
  );
}

/** "close and remove "G" (2 open tabs, 3 saved tabs)". */
function describeCloseAndRemove(removed: readonly TreeNode[], root: TreeNode): string {
  const closed = removed.filter((n) => n.kind === "tab" && n.liveTabId !== undefined).length;
  const saved = removedTabsBesides(removed, root.id).filter(
    (n) => n.liveTabId === undefined,
  ).length;
  return withDetail(
    `close and remove ${nameOf(root)}`,
    [closed ? plural(closed, "open tab") : "", saved ? plural(saved, "saved tab") : ""]
      .filter(Boolean)
      .join(", "),
  );
}

const past = (label: string) =>
  label
    .replace(/^remove/, "Removed")
    .replace(/^close and remove/, "Closed and removed")
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
  /**
   * "Remove from tree". `removed` is what `removeNode` returned: pruned containers, then the
   * removed part of the subtree, parents first. The undo re-adds them and moves the open tabs
   * and windows the tracker kept back where they were, with their titles and notes.
   */
  remove(before: Tree, removed: readonly TreeNode[], rootId: NodeId): HistoryEntry | null;
  /**
   * "Close tabs and remove". `removed` is what `closeAndRemove` returned. The undo re-adds the
   * subtree saved and reopens the tabs that were open, in place (as one window when the node
   * was an open window).
   */
  closeAndRemove(before: Tree, removed: readonly TreeNode[], rootId: NodeId): HistoryEntry | null;
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
  const root = before.get(rootId);
  if (!root) return null;
  // Nothing went and nothing the tracker kept was changed: a bare open tab, already in place.
  if (!removed.length && summarizeRemoval(before, root).reset === 0) return null;
  return {
    label: describeRemove(before, removed, root),
    undo: [opsStep(...unremoveOps(before, removed, rootId))],
    redo: [{ kind: "remove", id: rootId }],
  };
}

/** `reopen` step for `ids`; with `container` they come back as that container's window. */
function reopenStep(ids: NodeId[], container: NodeId | undefined): HistoryStep {
  return container === undefined ? { kind: "reopen", ids } : { kind: "reopen", ids, container };
}

function closeAndRemoveDraft(
  before: Tree,
  removed: readonly TreeNode[],
  rootId: NodeId,
): Draft | null {
  const root = before.get(rootId);
  if (!root || !removed.length) return null;
  const closed = removed.filter((n) => n.kind === "tab" && n.liveTabId !== undefined);
  const undo: HistoryStep[] = [opsStep(...readdOps(before, removed))];
  if (closed.length) {
    undo.push(
      reopenStep(
        closed.map((n) => n.id),
        isBound(root) ? rootId : undefined,
      ),
    );
  }
  return {
    label: describeCloseAndRemove(removed, root),
    undo,
    redo: [{ kind: "closeAndRemove", id: rootId }],
  };
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
    closeAndRemove: (before, removed, rootId) =>
      stamp(closeAndRemoveDraft(before, removed, rootId)),
    closeAndSave: (before, id) => stamp(closeAndSaveDraft(before, id)),
    reopen: (before, id) => stamp(reopenDraft(before, id)),
  };
}

/**
 * The two ways a row leaves the tree, counted: what "Remove from tree" deletes, keeps and resets,
 * and what "Close tabs and remove" closes. Container rows, tab and note rows and the undo entry
 * builder all read the same numbers, so labels, enabled states and toasts agree.
 *
 * "Remove from tree" never touches the browser. A node that mirrors something open (an open tab,
 * an open window) therefore stays; it is reset to a plain mirror instead (title and note dropped,
 * an open tab moved back directly under the container of its window). Pure: no DOM, no `browser.*`.
 */
import {
  buildChildIndex,
  descendantIds,
  isBound,
  isLiveTab,
  windowNodeOf,
  type ChildIndex,
  type NodeId,
  type Tree,
  type TreeNode,
} from "./model";

export interface RemovalSummary {
  /** Open tabs at or beneath the node: what "Close tabs and remove" closes and "Remove" keeps. */
  liveTabs: number;
  /** Nodes "Remove from tree" deletes: the node and its descendants that mirror nothing open. */
  removed: number;
  /**
   * Nodes it keeps but changes: an open window losing its title, note or parent; an open tab
   * losing its note or moving back under the container of its window because its parent goes
   * or it sat outside that container.
   */
  reset: number;
  /** The node itself mirrors an open tab or window and stays in the tree. */
  stays: boolean;
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `label`, or `label (detail)` when there is a detail to show. */
export function withDetail(label: string, detail: string): string {
  return detail ? `${label} (${detail})` : label;
}

/** Container id per open browser window, so "is this tab under its own window" is one lookup. */
function containersByWindow(tree: Tree): Map<number, NodeId> {
  const out = new Map<number, NodeId>();
  for (const n of tree.values()) {
    if (n.kind === "window" && n.liveWindowId !== undefined) out.set(n.liveWindowId, n.id);
  }
  return out;
}

interface ResetContext {
  tree: Tree;
  /** Container id per open browser window. */
  homes: ReadonlyMap<number, NodeId>;
  /** Subtree nodes already known to go; parents are visited before children. */
  removedIds: ReadonlySet<NodeId>;
}

/** Whether "Remove from tree" changes a node it keeps (see `RemovalSummary.reset`). */
function isReset(node: TreeNode, { tree, homes, removedIds }: ResetContext): boolean {
  if (node.note || (node.parentId !== null && removedIds.has(node.parentId))) return true;
  if (node.kind === "window") return !!node.title;
  const home = node.liveWindowId === undefined ? undefined : homes.get(node.liveWindowId);
  return windowNodeOf(tree, node.id)?.id !== home;
}

export function summarizeRemoval(
  tree: Tree,
  node: TreeNode,
  index: ChildIndex = buildChildIndex(tree),
): RemovalSummary {
  const removedIds = new Set<NodeId>();
  const context: ResetContext = { tree, homes: containersByWindow(tree), removedIds };
  const summary: RemovalSummary = {
    liveTabs: 0,
    removed: 0,
    reset: 0,
    stays: isLiveTab(node) || isBound(node),
  };
  const subtree = [node, ...descendantIds(tree, node.id, index).map((id) => tree.get(id))];
  for (const n of subtree) {
    if (!n) continue;
    if (isLiveTab(n)) summary.liveTabs++;
    if (isLiveTab(n) || isBound(n)) {
      if (isReset(n, context)) summary.reset++;
    } else {
      summary.removed++;
      removedIds.add(n.id);
    }
  }
  return summary;
}

/** "Remove from tree" has something to do: it deletes or resets at least one node. */
export function canRemove(s: RemovalSummary): boolean {
  return s.removed > 0 || s.reset > 0;
}

/** "Close tabs and remove" has something to close; without open tabs it is just "Remove". */
export function canCloseAndRemove(s: RemovalSummary): boolean {
  return s.liveTabs > 0;
}

/**
 * The label of "Remove from tree". An open window's container cannot leave the tree while the
 * window is open, so on it the action reads as what it does: remove the saved items beneath it.
 */
export function removeLabel(s: RemovalSummary, node: TreeNode): string {
  if (isBound(node)) return "Remove saved items";
  return withDetail(
    "Remove from tree",
    s.liveTabs ? `keeps ${plural(s.liveTabs, "open tab")}` : "",
  );
}

export function closeAndRemoveLabel(s: RemovalSummary): string {
  return withDetail("Close tabs and remove", s.liveTabs ? plural(s.liveTabs, "open tab") : "");
}

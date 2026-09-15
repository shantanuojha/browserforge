/**
 * Tree edits from the panel. Two ways to take a node out of the tree, kept deliberately apart:
 * `removeNode` never touches the browser (open tabs stay open and stay mirrored), while
 * `closeAndRemove` closes the open tabs beneath the node first. Moving a live tab may move the
 * browser tab.
 */
import {
  childrenOf,
  descendantIds,
  ops,
  windowNodeOf,
  type NodeId,
  type NodePatch,
  type OpBody,
  type Tree,
  type TreeNode,
} from "../model";
import { liveTabIdsIn } from "./containers";
import type { LiveBooks } from "./live-books";
import type { Placement } from "./placement";
import type { ContainerPruner } from "./pruning";
import type { TreeWriter } from "./tree-writer";
import type { LiveTab, TabsPort } from "./types";

export interface TreeEditsDeps {
  port: TabsPort;
  writer: TreeWriter;
  books: LiveBooks;
  placement: Placement;
  pruner: ContainerPruner;
}

export class TreeEdits {
  private readonly port: TabsPort;
  private readonly writer: TreeWriter;
  private readonly books: LiveBooks;
  private readonly placement: Placement;
  private readonly pruner: ContainerPruner;

  constructor(deps: TreeEditsDeps) {
    this.port = deps.port;
    this.writer = deps.writer;
    this.books = deps.books;
    this.placement = deps.placement;
    this.pruner = deps.pruner;
  }

  private get tree(): Tree {
    return this.writer.tree;
  }

  /**
   * Remove a node and its subtree from the tree without touching the browser. Saved tabs, notes
   * and closed containers beneath it go. Whatever mirrors something open stays, reset to a plain
   * mirror: an open tab's node loses its note and, when its parent goes or it sat outside the
   * container of its browser window, moves back directly under that container at its strip
   * position (open tabs nested under an open tab that stays travel with it); an open window's
   * container loses its title and note and, when its parent goes, moves to the root. All of it
   * happens in this one synchronous call, so the panel never shows an open tab missing. An
   * untitled container left empty is pruned. Returns the removed nodes, pruned containers first,
   * parents before children, so an undo can put them back in one batch of adds.
   */
  removeNode(nodeId: NodeId): TreeNode[] {
    const before = this.tree;
    const root = before.get(nodeId);
    if (!root) return [];
    const subtree = [
      root,
      ...descendantIds(before, nodeId).map((id) => before.get(id) as TreeNode),
    ];
    const kept = subtree.filter((n) => this.mirrorsSomethingOpen(n));
    const keptIds = new Set(kept.map((n) => n.id));
    const removed = subtree.filter((n) => !keptIds.has(n.id));
    const removedIds = new Set(removed.map((n) => n.id));
    this.writer.append(kept.flatMap((n) => resetOps(n)));
    this.rehomeContainers(kept, removedIds);
    this.rehomeTabs(kept, removedIds);
    // Only the topmost removed nodes need an op; the rest go with them.
    this.writer.append(
      removed
        .filter((n) => n.parentId === null || !removedIds.has(n.parentId))
        .map((n) => ops.remove(n.id)),
    );
    const pruned = this.pruner.pruneEmptyWindows(this.pruner.windowCandidates(root.parentId));
    return [...pruned.reverse(), ...removed];
  }

  /** A tab node of an open tab, or the container of an open window: the tracker keeps both. */
  private mirrorsSomethingOpen(node: TreeNode): boolean {
    if (node.kind === "tab") {
      return node.liveTabId !== undefined && this.books.hasTab(node.liveTabId);
    }
    return (
      node.kind === "window" &&
      node.liveWindowId !== undefined &&
      this.books.seesWindowOpen(node.liveWindowId)
    );
  }

  /** Open windows whose parent is being removed move to the root, where the browser put them. */
  private rehomeContainers(kept: readonly TreeNode[], removedIds: ReadonlySet<NodeId>): void {
    for (const n of kept) {
      if (n.kind !== "window" || n.parentId === null || !removedIds.has(n.parentId)) continue;
      this.writer.append([ops.move(n.id, null, childrenOf(this.tree, null).length)]);
    }
  }

  /**
   * Open tabs whose parent goes, or that sat outside the container of their window, go back
   * directly under that container at their strip position. Processed in strip order against the
   * tree as it changes, so a tab nested under an open tab that has just moved home is attached
   * again and stays nested: only what has to move moves.
   */
  private rehomeTabs(kept: readonly TreeNode[], removedIds: ReadonlySet<NodeId>): void {
    const tabs: { node: TreeNode; tab: LiveTab }[] = [];
    for (const node of kept) {
      const tab = node.liveTabId === undefined ? undefined : this.books.tab(node.liveTabId);
      if (tab) tabs.push({ node, tab });
    }
    tabs.sort(
      (a, b) => a.tab.windowId - b.tab.windowId || this.stripIndex(a.tab) - this.stripIndex(b.tab),
    );
    for (const { node, tab } of tabs) {
      const home = this.writer.windowNodeFor(tab.windowId);
      const current = this.tree.get(node.id) ?? node;
      const parentGoes = current.parentId !== null && removedIds.has(current.parentId);
      if (!parentGoes && !this.placement.isDetached(current, home)) continue;
      const index = this.placement.indexUnderWindow(tab, home);
      this.writer.append([ops.move(node.id, home.id, index)]);
    }
  }

  private stripIndex(tab: LiveTab): number {
    return this.books.orderOf(tab.windowId).indexOf(tab.id);
  }

  /**
   * Close the open tabs beneath a node without saving them, then remove the node and its
   * subtree. The tree is changed first so the resulting tab events do not re-save the nodes. An
   * untitled container emptied by the removal is pruned in the same step (the browser window is
   * about to close when its last tab goes). Returns every removed node, parents before children,
   * so the caller can put them back (undo) in one batch of adds.
   */
  async closeAndRemove(nodeId: NodeId): Promise<TreeNode[]> {
    const before = this.tree;
    const node = before.get(nodeId);
    if (!node) return [];
    const liveIds = liveTabIdsIn(before, nodeId);
    const subtree = [
      node,
      ...descendantIds(before, nodeId).map((id) => before.get(id) as TreeNode),
    ];
    this.writer.append([ops.remove(nodeId)]);
    const pruned = this.pruner.pruneEmptyWindows(
      this.pruner.windowCandidates(node.parentId),
      new Set(liveIds),
    );
    if (liveIds.length) await this.port.removeTabs(liveIds);
    return [...pruned.reverse(), ...subtree];
  }

  /**
   * Move a node from the UI. When a live tab lands in a different bound container, or in a new
   * position among its window's attached live tabs, the browser tab follows. Dropping it under
   * an unbound container (or at the root) is a tree-only move: the browser tab stays where it is
   * and the node is detached from strip ordering. An untitled container left childless by the
   * move is pruned; the pruned nodes are returned (outermost first) so an undo can restore them
   * before moving the node back.
   */
  async moveNode(nodeId: NodeId, parentId: NodeId | null, index: number): Promise<TreeNode[]> {
    const before = this.tree.get(nodeId);
    if (!before) return [];
    this.writer.append([ops.move(nodeId, parentId, index)]);
    const pruned =
      before.parentId !== parentId
        ? this.pruner.pruneEmptyWindows(this.pruner.windowCandidates(before.parentId)).reverse()
        : [];
    if (before.kind === "tab" && before.liveTabId !== undefined) {
      await this.followWithBrowserTab(nodeId, before.liveTabId);
    }
    return pruned;
  }

  /** Move the browser tab of `nodeId` to where the node now sits, when it sits in a bound window. */
  private async followWithBrowserTab(nodeId: NodeId, tabId: number): Promise<void> {
    const targetWindow = windowNodeOf(this.tree, nodeId);
    if (!targetWindow || targetWindow.liveWindowId === undefined) return;
    const windowId = targetWindow.liveWindowId;
    const targetIndex = this.placement.stripIndexForMove(tabId, targetWindow, windowId);
    if (targetIndex === null) return;
    const sameWindow = this.books.tab(tabId)?.windowId === windowId;
    const currentIndex = (this.books.stripOf(windowId) ?? []).indexOf(tabId);
    if (sameWindow && currentIndex === targetIndex) return;
    await this.port.moveTab(tabId, windowId, targetIndex);
  }
}

/** What "Remove from tree" resets on a node that stays: a container's title, anyone's note. */
function resetOps(node: TreeNode): OpBody[] {
  const patch: NodePatch = {};
  if (node.kind === "window" && node.title) patch.title = "";
  if (node.note) patch.note = undefined;
  return Object.keys(patch).length ? [ops.update(node.id, patch)] : [];
}

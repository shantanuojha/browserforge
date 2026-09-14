/**
 * Tree edits from the panel that the browser may have to follow: deleting a subtree closes its
 * tabs, moving a live tab may move the browser tab.
 */
import { descendantIds, ops, windowNodeOf, type NodeId, type Tree, type TreeNode } from "../model";
import { liveTabIdsIn } from "./containers";
import type { LiveBooks } from "./live-books";
import type { Placement } from "./placement";
import type { ContainerPruner } from "./pruning";
import type { TreeWriter } from "./tree-writer";
import type { TabsPort } from "./types";

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
   * Delete a node and its subtree from the tree, closing any live tabs beneath it without saving
   * them. The tree is changed first so the resulting tab events do not re-save the nodes. An
   * untitled container emptied by the delete is pruned in the same step (the browser window is
   * about to close when its last tab goes). Returns every removed node, parents before children,
   * so the caller can put them back (undo) in one batch of adds.
   */
  async deleteNode(nodeId: NodeId): Promise<TreeNode[]> {
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

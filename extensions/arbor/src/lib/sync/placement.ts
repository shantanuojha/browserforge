/**
 * Where a live tab belongs in the tree and where a tree node belongs in the strip. The two
 * orders are kept in step for the tabs *attached* to a bound container; a tab node the user
 * dragged elsewhere is *detached* and left alone.
 */
import {
  childrenOf,
  containerTabs,
  findByLiveTabId,
  findWindowByLiveId,
  windowNodeOf,
  type NodeId,
  type Tree,
  type TreeNode,
} from "../model";
import type { LiveBooks } from "./live-books";
import type { TabPlacement, TreeWriter } from "./tree-writer";
import type { LiveTab } from "./types";

export class Placement {
  constructor(
    private readonly writer: TreeWriter,
    private readonly books: LiveBooks,
  ) {}

  private get tree(): Tree {
    return this.writer.tree;
  }

  /**
   * A live tab node whose nearest container is not the one bound to the browser window it lives
   * in: the user dragged it out of its window's subtree (into a group, under a closed container,
   * ...) while the browser tab stayed put. Such a node is detached from tab-strip ordering: it
   * stays where the user put it, keeps receiving live updates (title, url, favicon, close) and is
   * ignored when the strip order is mirrored into the window node. Dropping it back under the
   * window node re-attaches it. Nothing but an explicit user move re-parents it.
   */
  isDetached(node: TreeNode, windowNode: TreeNode): boolean {
    return node.kind === "tab" && windowNodeOf(this.tree, node.id)?.id !== windowNode.id;
  }

  /**
   * Depth-first ids of the live tabs attached to a container. Subtrees of nested containers are
   * skipped: their tabs are ordered by their own window (or detached from this one).
   */
  attachedOrderInTree(windowNode: TreeNode): number[] {
    const out: number[] = [];
    for (const n of containerTabs(this.tree, windowNode.id)) {
      if (n.liveTabId !== undefined) out.push(n.liveTabId);
    }
    return out;
  }

  /** The browser's strip order minus detached tabs: the sequence the window node's subtree mirrors. */
  private attachedOrderInBrowser(windowId: number, windowNode: TreeNode): number[] {
    const tree = this.tree;
    return (this.books.stripOf(windowId) ?? []).filter((id) => {
      const node = findByLiveTabId(tree, id);
      return !node || !this.isDetached(node, windowNode);
    });
  }

  /** Whether the window node's attached tabs already follow the strip. */
  isConsistent(windowId: number): boolean {
    const windowNode = findWindowByLiveId(this.tree, windowId);
    if (!windowNode) return false;
    const inTree = this.attachedOrderInTree(windowNode);
    const inBrowser = this.attachedOrderInBrowser(windowId, windowNode);
    return inTree.length === inBrowser.length && inTree.every((id, i) => id === inBrowser[i]);
  }

  /** Under its opener, when the opener is attached to the same window and not the node itself. */
  private underOpener(tab: LiveTab, windowNode: TreeNode, excludeId?: NodeId): TabPlacement | null {
    if (tab.openerTabId === undefined) return null;
    const opener = findByLiveTabId(this.tree, tab.openerTabId);
    if (!opener || opener.id === excludeId || this.isDetached(opener, windowNode)) return null;
    const kids = childrenOf(this.tree, opener.id).filter((k) => k.id !== excludeId);
    return { parentId: opener.id, index: kids.length };
  }

  /**
   * Right after the nearest left-hand neighbour that takes part in strip ordering. Detached
   * neighbours sit wherever the user put them and must not attract the tab there. `appendAtEnd`
   * reports a neighbour we hold no node for yet, which keeps the pre-detachment behaviour.
   */
  private afterLeftNeighbour(
    tab: LiveTab,
    windowNode: TreeNode,
    excludeId?: NodeId,
  ): TabPlacement | { appendAtEnd: boolean } {
    const tree = this.tree;
    const order = this.books.orderOf(tab.windowId);
    for (let pos = order.indexOf(tab.id) - 1; pos >= 0; pos--) {
      const prev = findByLiveTabId(tree, order[pos] as number);
      if (!prev) return { appendAtEnd: true };
      // A root-level tab node has no container ancestor, so it is detached as well.
      if (prev.id === excludeId || prev.parentId === null || this.isDetached(prev, windowNode)) {
        continue;
      }
      const siblings = childrenOf(tree, prev.parentId).filter((s) => s.id !== excludeId);
      return { parentId: prev.parentId, index: siblings.indexOf(prev) + 1 };
    }
    return { appendAtEnd: false };
  }

  /** Where a tab at its current browser position should sit in the tree. */
  placementFor(tab: LiveTab, excludeId?: NodeId): TabPlacement {
    const windowNode = this.writer.windowNodeFor(tab.windowId);
    const opener = this.underOpener(tab, windowNode, excludeId);
    if (opener) return opener;
    const neighbour = this.afterLeftNeighbour(tab, windowNode, excludeId);
    if ("parentId" in neighbour) return neighbour;
    return {
      parentId: windowNode.id,
      index: neighbour.appendAtEnd ? childrenOf(this.tree, windowNode.id).length : 0,
    };
  }

  /**
   * Index directly under `windowNode` for the node of live `tab` going back to being a plain
   * mirror of its browser tab: right after the last direct child mirroring an earlier strip
   * position, else right before the first mirroring a later one, else last. Children that are
   * not live tabs of this window (saved tabs, notes, nested containers, detached tabs) do not
   * take part; tabs nested deeper are their parents' business.
   */
  indexUnderWindow(tab: LiveTab, windowNode: TreeNode): number {
    const strip = this.books.orderOf(tab.windowId);
    const mine = strip.indexOf(tab.id);
    const positions = childrenOf(this.tree, windowNode.id).map((k) =>
      k.kind === "tab" && k.liveTabId !== undefined && k.liveTabId !== tab.id
        ? strip.indexOf(k.liveTabId)
        : -1,
    );
    for (let i = positions.length - 1; i >= 0; i--) {
      const p = positions[i] as number;
      if (p >= 0 && p < mine) return i + 1;
    }
    const successor = positions.findIndex((p) => p > mine);
    return successor >= 0 ? successor : positions.length;
  }

  /**
   * Strip index at which the tab for saved `nodeId` (inside bound `windowNode`'s subtree) must
   * open so the window's attached depth-first order keeps matching the strip: right after the
   * nearest attached predecessor still in the strip, else right before the nearest attached
   * successor, else at the end (`undefined`).
   */
  stripIndexFor(nodeId: NodeId, windowNode: TreeNode, windowId: number): number | undefined {
    const before: number[] = [];
    const after: number[] = [];
    let passed = false;
    for (const n of containerTabs(this.tree, windowNode.id)) {
      if (n.id === nodeId) passed = true;
      else if (n.liveTabId !== undefined) (passed ? after : before).push(n.liveTabId);
    }
    const strip = this.books.orderOf(windowId);
    const pred = before.reverse().find((id) => strip.includes(id));
    if (pred !== undefined) return strip.indexOf(pred) + 1;
    const succ = after.find((id) => strip.includes(id));
    return succ === undefined ? undefined : strip.indexOf(succ);
  }

  /**
   * Strip index the live tab `tabId` must move to so it follows its node's place among the
   * attached tabs of `targetWindow`: right after the nearest attached predecessor still in the
   * strip (detached tabs may sit anywhere in it), else right before the nearest attached
   * successor, else unchanged (same window) or last. `null` when the tab is not attached there.
   */
  stripIndexForMove(tabId: number, targetWindow: TreeNode, windowId: number): number | null {
    const desired = this.attachedOrderInTree(targetWindow);
    const pos = desired.indexOf(tabId);
    if (pos < 0) return null;
    const currentOrder = this.books.stripOf(windowId) ?? [];
    const sameWindow = this.books.tab(tabId)?.windowId === windowId;
    const others = currentOrder.filter((id) => id !== tabId);
    const pred = desired
      .slice(0, pos)
      .reverse()
      .find((id) => others.includes(id));
    if (pred !== undefined) return others.indexOf(pred) + 1;
    const succ = desired.slice(pos + 1).find((id) => others.includes(id));
    if (succ !== undefined) return others.indexOf(succ);
    return sameWindow ? currentOrder.indexOf(tabId) : others.length;
  }
}

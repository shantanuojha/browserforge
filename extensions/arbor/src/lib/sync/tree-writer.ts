/**
 * The tree-side vocabulary of the tracker: the window node bound to a browser window (created on
 * demand), a tab node for a browser tab, the patch that brings a node up to date with its tab,
 * and what becomes of a node whose tab closed. Every write goes through `append`.
 */
import type { Clock } from "@browserforge/shared";
import {
  childrenOf,
  findWindowByLiveId,
  makeNode,
  ops,
  type NodeId,
  type NodePatch,
  type Op,
  type OpBody,
  type Tree,
  type TreeNode,
} from "../model";
import type { TreeStore } from "../store/types";
import { isBlankUrl, type LiveTab } from "./types";
import { currentUrl, tabTitle } from "./url";

export interface TabPlacement {
  parentId: NodeId;
  index: number;
}

export class TreeWriter {
  constructor(
    private readonly store: TreeStore,
    private readonly newId: () => string,
    private readonly clock: Clock,
  ) {}

  get tree(): Tree {
    return this.store.getTree();
  }

  append(bodies: readonly OpBody[]): Op[] {
    return bodies.length ? this.store.append(bodies) : [];
  }

  /** The container bound to browser window `windowId`, created (untitled) on demand. */
  windowNodeFor(windowId: number): TreeNode {
    const existing = findWindowByLiveId(this.tree, windowId);
    if (existing) return existing;
    const node = makeNode({
      id: this.newId(),
      parentId: null,
      kind: "window",
      title: "",
      liveWindowId: windowId,
      ts: this.clock(),
    });
    this.store.append([ops.add(node)]);
    return node;
  }

  /** A fresh live tab node for `tab` at `placement`. */
  createTabNode(tab: LiveTab, placement: TabPlacement): TreeNode {
    const url = tab.pendingUrl || tab.url;
    const node = makeNode({
      id: this.newId(),
      parentId: placement.parentId,
      kind: "tab",
      title: tabTitle({ title: tab.title, url }),
      url: url || undefined,
      favIconUrl: tab.favIconUrl || undefined,
      liveTabId: tab.id,
      liveWindowId: tab.windowId,
      ts: this.clock(),
    });
    this.store.append([ops.add(node, placement.index)]);
    return node;
  }

  /** What `node` must change to describe `tab`; `null` when it already does. */
  patchFor(node: TreeNode, tab: LiveTab): NodePatch | null {
    const patch: NodePatch = {};
    const url = currentUrl(tab);
    const title = tabTitle({ title: tab.title, url });
    if (node.title !== title) patch.title = title;
    if (url && node.url !== url) patch.url = url;
    if (tab.favIconUrl && node.favIconUrl !== tab.favIconUrl) patch.favIconUrl = tab.favIconUrl;
    if (node.liveTabId !== tab.id) patch.liveTabId = tab.id;
    if (node.liveWindowId !== tab.windowId) patch.liveWindowId = tab.windowId;
    return Object.keys(patch).length ? patch : null;
  }

  /** Bring `node` up to date with `tab`, if anything changed. */
  syncWithTab(node: TreeNode, tab: LiveTab): void {
    const patch = this.patchFor(node, tab);
    if (patch) this.store.append([ops.update(node.id, patch)]);
  }

  /**
   * Bind a saved node to a live tab where the node sits. Nothing is moved. The window node is
   * created on demand so the tab has a window node to be attached to or detached from.
   */
  adoptNode(node: TreeNode, tab: LiveTab): void {
    this.windowNodeFor(tab.windowId);
    const patch = this.patchFor(node, tab) ?? {};
    // Keep the saved title/favicon until the page reports its own.
    if (!tab.title) delete patch.title;
    if (!tab.favIconUrl) delete patch.favIconUrl;
    if (Object.keys(patch).length) this.store.append([ops.update(node.id, patch)]);
  }

  /** A closed tab becomes a saved node, unless it was a blank page with nothing on it: dropped. */
  saveOrDrop(node: TreeNode): OpBody {
    const drop = isBlankUrl(node.url) && !node.note && childrenOf(this.tree, node.id).length === 0;
    return drop
      ? ops.remove(node.id)
      : ops.update(node.id, { liveTabId: undefined, liveWindowId: undefined });
  }

  /** Clear the live binding of a container. */
  unbindWindow(nodeId: NodeId): OpBody {
    return ops.update(nodeId, { liveWindowId: undefined });
  }
}

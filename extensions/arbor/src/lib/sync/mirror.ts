/**
 * Mirrors browser events into the tree: tabs created, updated, moved, attached, removed,
 * replaced, activated; windows created, removed and focused. Each handler updates the live books
 * first, then the tree, and never touches the browser.
 */
import {
  childrenOf,
  findByLiveTabId,
  findWindowByLiveId,
  ops,
  windowNodeOf,
  type NodeId,
  type OpBody,
  type Tree,
  type TreeNode,
} from "../model";
import type { AdoptionRegistry, WindowAdoption } from "./adoption";
import type { LiveBooks } from "./live-books";
import type { Placement } from "./placement";
import type { ContainerPruner } from "./pruning";
import { savedTabByUrl } from "./saved-tabs";
import type { TreeWriter } from "./tree-writer";
import { isTrackableWindow, type LiveTab, type LiveWindow, type TrackerEventSink } from "./types";

export interface MirrorDeps {
  writer: TreeWriter;
  books: LiveBooks;
  placement: Placement;
  pruner: ContainerPruner;
  adoptions: AdoptionRegistry;
}

export class LiveMirror implements TrackerEventSink {
  private readonly writer: TreeWriter;
  private readonly books: LiveBooks;
  private readonly placement: Placement;
  private readonly pruner: ContainerPruner;
  private readonly adoptions: AdoptionRegistry;

  constructor(deps: MirrorDeps) {
    this.writer = deps.writer;
    this.books = deps.books;
    this.placement = deps.placement;
    this.pruner = deps.pruner;
    this.adoptions = deps.adoptions;
  }

  private get tree(): Tree {
    return this.writer.tree;
  }

  /** The node for a new browser tab: a pending restore's node when the tab fulfils one, else new. */
  adoptOrCreate(tab: LiveTab): NodeId {
    const adoption = this.adoptions.claimTab(tab);
    const adopted = adoption ? this.tree.get(adoption.nodeId) : undefined;
    if (adopted) {
      this.writer.adoptNode(adopted, tab);
      return adopted.id;
    }
    return this.writer.createTabNode(tab, this.placement.placementFor(tab)).id;
  }

  handleTabCreated(tab: LiveTab): void {
    if (this.books.ignoresWindow(tab.windowId)) return;
    this.books.insertTabRecord(tab);
    const existing = findByLiveTabId(this.tree, tab.id);
    if (existing) {
      this.writer.syncWithTab(existing, tab);
      return;
    }
    this.adoptOrCreate(tab);
  }

  handleTabUpdated(tabId: number, tab: LiveTab): void {
    if (this.books.ignoresWindow(tab.windowId)) return;
    if (!this.books.hasTab(tabId)) {
      this.handleTabCreated(tab);
      return;
    }
    this.books.updateTab(tabId, tab);
    const node = findByLiveTabId(this.tree, tabId);
    if (!node) {
      this.adoptOrCreate(tab);
      return;
    }
    this.writer.syncWithTab(node, tab);
  }

  handleTabMoved(tabId: number, info: { windowId: number; toIndex: number }): void {
    if (this.books.moveInStrip(tabId, info.windowId, info.toIndex)) this.reconcilePosition(tabId);
  }

  handleTabAttached(tabId: number, info: { newWindowId: number; newPosition: number }): void {
    const record = this.books.tab(tabId) ?? { id: tabId, windowId: info.newWindowId, index: 0 };
    this.books.removeTabRecord(tabId);
    this.books.insertTabRecord({ ...record, windowId: info.newWindowId, index: info.newPosition });
    const node = findByLiveTabId(this.tree, tabId);
    if (!node) return;
    const windowNode = this.writer.windowNodeFor(info.newWindowId);
    const batch: OpBody[] = [];
    // A node the user had already detached from its old window stays where it is; one that sat
    // under its old window node follows the tab into the new window.
    if (!this.wasDetached(node) && windowNodeOf(this.tree, node.id)?.id !== windowNode.id) {
      const tab = this.books.tab(tabId) ?? record;
      const { parentId, index } = this.placement.placementFor(tab, node.id);
      batch.push(ops.move(node.id, parentId, index));
    }
    if (node.liveWindowId !== info.newWindowId) {
      batch.push(ops.update(node.id, { liveWindowId: info.newWindowId }));
    }
    this.writer.append(batch);
  }

  /** Whether `node` was detached from the window it claims to live in. */
  private wasDetached(node: TreeNode): boolean {
    const oldWindowNode =
      node.liveWindowId === undefined
        ? undefined
        : findWindowByLiveId(this.tree, node.liveWindowId);
    return oldWindowNode !== undefined && this.placement.isDetached(node, oldWindowNode);
  }

  handleTabDetached(tabId: number, info: { oldWindowId: number }): void {
    this.books.removeFromStrip(tabId, info.oldWindowId);
  }

  handleTabRemoved(tabId: number): void {
    const windowId = this.books.tab(tabId)?.windowId;
    this.books.removeTabRecord(tabId);
    const node = findByLiveTabId(this.tree, tabId);
    if (node) this.writer.append([this.writer.saveOrDrop(node)]);
    // A dropped blank tab, or a node deleted from the panel before its tab closed, may have left
    // its window node empty; the real window is gone too once its last tab has closed.
    this.pruner.pruneEmptyWindows([
      ...(node ? this.pruner.windowCandidates(node.parentId) : []),
      windowId === undefined ? undefined : findWindowByLiveId(this.tree, windowId)?.id,
    ]);
  }

  handleTabReplaced(addedTabId: number, removedTabId: number): void {
    const node = findByLiveTabId(this.tree, removedTabId);
    const replaced = this.books.replaceTabId(removedTabId, addedTabId);
    if (!replaced && node?.liveWindowId !== undefined) {
      // No record (the swap happened while we were not looking): keep the books consistent so
      // the node is not mistaken for a closed tab later.
      const order = this.books.orderOf(node.liveWindowId);
      this.books.insertTabRecord({
        id: addedTabId,
        windowId: node.liveWindowId,
        index: order.length,
      });
    }
    if (node) this.writer.append([ops.update(node.id, { liveTabId: addedTabId })]);
  }

  handleTabActivated(info: { tabId: number; windowId: number }): void {
    this.books.setActive(info.windowId, info.tabId);
  }

  handleWindowCreated(win: LiveWindow): void {
    this.books.noteWindow(win.id, isTrackableWindow(win));
    if (!isTrackableWindow(win)) return;
    const adoption = this.adoptions.takeWindow();
    const container = adoption ? this.tree.get(adoption.nodeId) : undefined;
    if (adoption && container?.kind === "window" && container.liveWindowId === undefined) {
      this.bindReopeningContainer(container, win.id, adoption);
      return;
    }
    this.writer.windowNodeFor(win.id);
  }

  /**
   * The window a container is being reopened as has appeared: bind it and queue adoptions so
   * the `tabs.onCreated` events reuse the saved children by url.
   */
  private bindReopeningContainer(
    container: TreeNode,
    windowId: number,
    adoption: WindowAdoption,
  ): void {
    this.writer.append([ops.update(container.id, { liveWindowId: windowId })]);
    const claim = { used: new Set<NodeId>(), only: adoption.only };
    for (const url of adoption.urls) {
      const target = savedTabByUrl(this.tree, container.id, url, claim);
      if (!target) continue;
      claim.used.add(target.id);
      this.adoptions.expectTab(target.id, url, windowId);
    }
  }

  /**
   * The browser window is gone: its tab nodes (wherever the user put them) become saved in place
   * and its container stays in the tree, unbound, so the user can reopen it later. Only an
   * untitled container left without anything under it is removed.
   */
  handleWindowRemoved(windowId: number): void {
    this.books.forgetWindow(windowId);
    const tree = this.tree;
    const windowNode = findWindowByLiveId(tree, windowId);
    const batch: OpBody[] = [];
    for (const n of tree.values()) {
      if (n.kind === "tab" && n.liveWindowId === windowId && n.liveTabId !== undefined) {
        batch.push(this.writer.saveOrDrop(n));
      }
    }
    if (windowNode) batch.push(this.writer.unbindWindow(windowNode.id));
    this.writer.append(batch);
    if (windowNode) this.pruner.pruneEmptyWindows([windowNode.id]);
  }

  /**
   * Only windows the tree mirrors count as "focused": a popup, devtools or app window taking
   * focus must not become the target of the next restore (its tabs are ignored, so a tab opened
   * there would never be mirrored). `undefined` (no Chrome window focused) is kept as is.
   */
  handleWindowFocusChanged(windowId: number | undefined): void {
    if (windowId !== undefined && this.books.ignoresWindow(windowId)) return;
    this.books.focusedWindowId = windowId;
  }

  /** Move a live tab node so the tree order matches the browser order again. */
  private reconcilePosition(tabId: number): void {
    const record = this.books.tab(tabId);
    if (!record) return;
    if (this.placement.isConsistent(record.windowId)) return;
    const node = findByLiveTabId(this.tree, tabId);
    if (!node) return;
    if (this.placement.isDetached(node, this.writer.windowNodeFor(record.windowId))) return;
    const { parentId, index } = this.placement.placementFor(record, node.id);
    if (node.parentId === parentId) {
      const currentIndex = childrenOf(this.tree, parentId).indexOf(node);
      if (currentIndex === index) return;
    }
    this.writer.append([ops.move(node.id, parentId, index)]);
  }
}

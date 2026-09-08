import { newId } from "../ids";
import {
  buildChildIndex,
  childrenOf,
  descendantIds,
  findByLiveTabId,
  findWindowByLiveId,
  makeNode,
  ops,
  windowNodeOf,
  type NodeId,
  type NodePatch,
  type OpBody,
  type Tree,
  type TreeNode,
} from "../model";
import type { TreeStore } from "../store/types";
import {
  isBlankUrl,
  isTrackableWindow,
  type LiveTab,
  type LiveWindow,
  type RebuildReport,
  type TabsPort,
} from "./types";

interface TabAdoption {
  nodeId: NodeId;
  url: string;
  windowId: number | undefined;
}

export interface LiveState {
  activeTabIds: number[];
  focusedWindowId: number | undefined;
}

export interface TrackerOptions {
  newId?: () => string;
  now?: () => number;
}

function tabTitle(tab: { title?: string | undefined; url?: string | undefined }): string {
  if (tab.title) return tab.title;
  if (tab.url) {
    try {
      return new URL(tab.url).hostname || tab.url;
    } catch {
      return tab.url;
    }
  }
  return "New tab";
}

function sameUrl(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const strip = (u: string) => u.replace(/\/$/, "").replace(/^http:\/\//, "https://");
  return strip(a) === strip(b);
}

/**
 * Mirrors live windows and tabs into the tree. Pure with respect to the browser: events are fed
 * through `handle*` methods and browser mutations go through the injected `TabsPort`.
 *
 * Invariants it maintains:
 * - a live tab node has `liveTabId` and `liveWindowId` and lives under the matching window node;
 * - a closed tab becomes a saved node (live ids cleared) unless it was a blank new tab;
 * - the depth-first order of live tab nodes under a window node follows the browser's tab strip
 *   whenever the tracker itself changed the tree (user nesting is preserved otherwise).
 */
export class TabTracker {
  /** Browser tab order per window (ids in strip order). */
  private readonly windowTabs = new Map<number, number[]>();
  private readonly tabs = new Map<number, LiveTab>();
  private readonly activeTabs = new Map<number, number>();
  /** Window ids we have seen, with whether they are worth tracking (normal windows only). */
  private readonly knownWindows = new Map<number, boolean>();
  private focusedWindowId: number | undefined;
  private adoptTabs: TabAdoption[] = [];
  private adoptWindow: { nodeId: NodeId; urls: string[] } | null = null;
  private readonly newId: () => string;
  private readonly now: () => number;

  constructor(
    private readonly store: TreeStore,
    private readonly port: TabsPort,
    options: TrackerOptions = {},
  ) {
    this.newId = options.newId ?? newId;
    this.now = options.now ?? (() => Date.now());
  }

  private get tree(): Tree {
    return this.store.getTree();
  }

  getLiveState(): LiveState {
    return { activeTabIds: [...this.activeTabs.values()], focusedWindowId: this.focusedWindowId };
  }

  // -- bookkeeping of the browser's own order ---------------------------------------------------

  private orderOf(windowId: number): number[] {
    let order = this.windowTabs.get(windowId);
    if (!order) {
      order = [];
      this.windowTabs.set(windowId, order);
    }
    return order;
  }

  private insertTabRecord(tab: LiveTab): void {
    this.removeTabRecord(tab.id);
    const order = this.orderOf(tab.windowId);
    order.splice(Math.max(0, Math.min(tab.index, order.length)), 0, tab.id);
    this.tabs.set(tab.id, { ...tab });
    if (tab.active) this.activeTabs.set(tab.windowId, tab.id);
  }

  private removeTabRecord(tabId: number): void {
    const prev = this.tabs.get(tabId);
    if (!prev) return;
    const order = this.windowTabs.get(prev.windowId);
    if (order) {
      const i = order.indexOf(tabId);
      if (i >= 0) order.splice(i, 1);
    }
    this.tabs.delete(tabId);
    if (this.activeTabs.get(prev.windowId) === tabId) this.activeTabs.delete(prev.windowId);
  }

  // -- tree helpers ---------------------------------------------------------------------------

  private windowNodeFor(windowId: number): TreeNode {
    const existing = findWindowByLiveId(this.tree, windowId);
    if (existing) return existing;
    const node = makeNode({
      id: this.newId(),
      parentId: null,
      kind: "window",
      title: "Window",
      liveWindowId: windowId,
      ts: this.now(),
    });
    this.store.append([ops.add(node)]);
    return node;
  }

  /** Depth-first live tab ids under a window node. */
  private liveOrderInTree(windowNode: TreeNode): number[] {
    const tree = this.tree;
    const out: number[] = [];
    for (const id of descendantIds(tree, windowNode.id)) {
      const n = tree.get(id);
      if (n?.kind === "tab" && n.liveTabId !== undefined) out.push(n.liveTabId);
    }
    return out;
  }

  private isConsistent(windowId: number): boolean {
    const windowNode = findWindowByLiveId(this.tree, windowId);
    if (!windowNode) return false;
    const inTree = this.liveOrderInTree(windowNode);
    const inBrowser = this.windowTabs.get(windowId) ?? [];
    return inTree.length === inBrowser.length && inTree.every((id, i) => id === inBrowser[i]);
  }

  /** Where a tab at its current browser position should sit in the tree. */
  private placementFor(tab: LiveTab, excludeId?: NodeId): { parentId: NodeId; index: number } {
    const tree = this.tree;
    const windowNode = this.windowNodeFor(tab.windowId);
    if (tab.openerTabId !== undefined) {
      const opener = findByLiveTabId(tree, tab.openerTabId);
      if (
        opener &&
        opener.id !== excludeId &&
        windowNodeOf(tree, opener.id)?.id === windowNode.id
      ) {
        const kids = childrenOf(tree, opener.id).filter((k) => k.id !== excludeId);
        return { parentId: opener.id, index: kids.length };
      }
    }
    const order = this.orderOf(tab.windowId);
    const pos = order.indexOf(tab.id);
    const prevId = pos > 0 ? order[pos - 1] : undefined;
    const prev = prevId === undefined ? undefined : findByLiveTabId(tree, prevId);
    if (prev && prev.id !== excludeId && prev.parentId !== null) {
      const siblings = childrenOf(tree, prev.parentId).filter((s) => s.id !== excludeId);
      return { parentId: prev.parentId, index: siblings.indexOf(prev) + 1 };
    }
    return {
      parentId: windowNode.id,
      index: pos <= 0 ? 0 : childrenOf(tree, windowNode.id).length,
    };
  }

  private patchFor(node: TreeNode, tab: LiveTab): NodePatch | null {
    const patch: NodePatch = {};
    const url = tab.url || tab.pendingUrl;
    const title = tabTitle({ title: tab.title, url });
    if (node.title !== title) patch.title = title;
    if (url && node.url !== url) patch.url = url;
    if (tab.favIconUrl && node.favIconUrl !== tab.favIconUrl) patch.favIconUrl = tab.favIconUrl;
    if (node.liveTabId !== tab.id) patch.liveTabId = tab.id;
    if (node.liveWindowId !== tab.windowId) patch.liveWindowId = tab.windowId;
    return Object.keys(patch).length ? patch : null;
  }

  private adoptOrCreate(tab: LiveTab): NodeId {
    const tree = this.tree;
    const url = tab.pendingUrl || tab.url;
    const adoptIdx = this.adoptTabs.findIndex(
      (a) => (a.windowId === undefined || a.windowId === tab.windowId) && sameUrl(a.url, url),
    );
    if (adoptIdx >= 0) {
      const [adoption] = this.adoptTabs.splice(adoptIdx, 1);
      const node = adoption ? tree.get(adoption.nodeId) : undefined;
      if (node) {
        this.adoptNode(node, tab);
        return node.id;
      }
    }
    const { parentId, index } = this.placementFor(tab);
    const node = makeNode({
      id: this.newId(),
      parentId,
      kind: "tab",
      title: tabTitle({ title: tab.title, url }),
      url: url || undefined,
      favIconUrl: tab.favIconUrl || undefined,
      liveTabId: tab.id,
      liveWindowId: tab.windowId,
      ts: this.now(),
    });
    this.store.append([ops.add(node, index)]);
    return node.id;
  }

  /** Bind a saved node to a live tab, moving it under the right window when needed. */
  private adoptNode(node: TreeNode, tab: LiveTab): void {
    const batch: OpBody[] = [];
    const windowNode = this.windowNodeFor(tab.windowId);
    if (windowNodeOf(this.tree, node.id)?.id !== windowNode.id) {
      batch.push(ops.move(node.id, windowNode.id, childrenOf(this.tree, windowNode.id).length));
    }
    const patch = this.patchFor(node, tab) ?? {};
    // Keep the saved title/favicon until the page reports its own.
    if (!tab.title) delete patch.title;
    if (!tab.favIconUrl) delete patch.favIconUrl;
    if (Object.keys(patch).length) batch.push(ops.update(node.id, patch));
    if (batch.length) this.store.append(batch);
  }

  // -- browser events -------------------------------------------------------------------------

  /** Tabs in popup/devtools/app windows are not part of the tree. Unknown windows are trusted. */
  private ignoresWindow(windowId: number): boolean {
    return this.knownWindows.get(windowId) === false;
  }

  handleTabCreated(tab: LiveTab): void {
    if (this.ignoresWindow(tab.windowId)) return;
    this.insertTabRecord(tab);
    const existing = findByLiveTabId(this.tree, tab.id);
    if (existing) {
      const patch = this.patchFor(existing, tab);
      if (patch) this.store.append([ops.update(existing.id, patch)]);
      return;
    }
    this.adoptOrCreate(tab);
  }

  handleTabUpdated(tabId: number, tab: LiveTab): void {
    if (this.ignoresWindow(tab.windowId)) return;
    const record = this.tabs.get(tabId);
    if (!record) {
      this.handleTabCreated(tab);
      return;
    }
    this.tabs.set(tabId, { ...record, ...tab, index: record.index });
    const node = findByLiveTabId(this.tree, tabId);
    if (!node) {
      this.adoptOrCreate(tab);
      return;
    }
    const patch = this.patchFor(node, tab);
    if (patch) this.store.append([ops.update(node.id, patch)]);
  }

  handleTabMoved(tabId: number, info: { windowId: number; toIndex: number }): void {
    const record = this.tabs.get(tabId);
    if (!record) return;
    const order = this.orderOf(info.windowId);
    const from = order.indexOf(tabId);
    if (from >= 0) order.splice(from, 1);
    order.splice(Math.max(0, Math.min(info.toIndex, order.length)), 0, tabId);
    this.tabs.set(tabId, { ...record, windowId: info.windowId });
    this.reconcilePosition(tabId);
  }

  handleTabAttached(tabId: number, info: { newWindowId: number; newPosition: number }): void {
    const record = this.tabs.get(tabId) ?? { id: tabId, windowId: info.newWindowId, index: 0 };
    this.removeTabRecord(tabId);
    this.insertTabRecord({ ...record, windowId: info.newWindowId, index: info.newPosition });
    const node = findByLiveTabId(this.tree, tabId);
    if (!node) return;
    const windowNode = this.windowNodeFor(info.newWindowId);
    const batch: OpBody[] = [];
    if (windowNodeOf(this.tree, node.id)?.id !== windowNode.id) {
      const tab = this.tabs.get(tabId) ?? record;
      const { parentId, index } = this.placementFor(tab, node.id);
      batch.push(ops.move(node.id, parentId, index));
    }
    if (node.liveWindowId !== info.newWindowId) {
      batch.push(ops.update(node.id, { liveWindowId: info.newWindowId }));
    }
    if (batch.length) this.store.append(batch);
  }

  handleTabDetached(tabId: number, info: { oldWindowId: number }): void {
    const order = this.windowTabs.get(info.oldWindowId);
    if (order) {
      const i = order.indexOf(tabId);
      if (i >= 0) order.splice(i, 1);
    }
  }

  handleTabRemoved(tabId: number): void {
    this.removeTabRecord(tabId);
    const node = findByLiveTabId(this.tree, tabId);
    if (!node) return;
    this.store.append([this.saveOrDrop(node)]);
  }

  handleTabReplaced(addedTabId: number, removedTabId: number): void {
    const record = this.tabs.get(removedTabId);
    if (record) {
      const order = this.orderOf(record.windowId);
      const i = order.indexOf(removedTabId);
      if (i >= 0) order[i] = addedTabId;
      this.tabs.delete(removedTabId);
      this.tabs.set(addedTabId, { ...record, id: addedTabId });
      if (this.activeTabs.get(record.windowId) === removedTabId) {
        this.activeTabs.set(record.windowId, addedTabId);
      }
    }
    const node = findByLiveTabId(this.tree, removedTabId);
    if (node) this.store.append([ops.update(node.id, { liveTabId: addedTabId })]);
  }

  handleTabActivated(info: { tabId: number; windowId: number }): void {
    this.activeTabs.set(info.windowId, info.tabId);
    const record = this.tabs.get(info.tabId);
    if (record) this.tabs.set(info.tabId, { ...record, active: true });
  }

  handleWindowCreated(win: LiveWindow): void {
    this.knownWindows.set(win.id, isTrackableWindow(win));
    if (!isTrackableWindow(win)) return;
    if (this.adoptWindow) {
      const { nodeId, urls } = this.adoptWindow;
      this.adoptWindow = null;
      const node = this.tree.get(nodeId);
      if (node && node.kind === "window" && node.liveWindowId === undefined) {
        this.store.append([ops.update(nodeId, { liveWindowId: win.id })]);
        // Queue adoptions so the tabs.onCreated events reuse the saved children by url.
        const used = new Set<NodeId>();
        for (const url of urls) {
          const target = this.savedDescendantByUrl(nodeId, url, used);
          if (target) {
            used.add(target.id);
            this.adoptTabs.push({ nodeId: target.id, url, windowId: win.id });
          }
        }
        return;
      }
    }
    this.windowNodeFor(win.id);
  }

  handleWindowRemoved(windowId: number): void {
    this.knownWindows.delete(windowId);
    const order = this.windowTabs.get(windowId) ?? [];
    for (const tabId of [...order]) this.removeTabRecord(tabId);
    this.windowTabs.delete(windowId);
    this.activeTabs.delete(windowId);
    if (this.focusedWindowId === windowId) this.focusedWindowId = undefined;
    const tree = this.tree;
    const windowNode = findWindowByLiveId(tree, windowId);
    const batch: OpBody[] = [];
    for (const n of tree.values()) {
      if (n.kind === "tab" && n.liveWindowId === windowId && n.liveTabId !== undefined) {
        batch.push(this.saveOrDrop(n));
      }
    }
    if (windowNode) {
      batch.push(ops.update(windowNode.id, { liveWindowId: undefined }));
    }
    if (batch.length) this.store.append(batch);
    if (windowNode && childrenOf(this.tree, windowNode.id).length === 0) {
      this.store.append([ops.remove(windowNode.id)]);
    }
  }

  handleWindowFocusChanged(windowId: number | undefined): void {
    this.focusedWindowId = windowId;
  }

  private saveOrDrop(node: TreeNode): OpBody {
    const drop = isBlankUrl(node.url) && !node.note && childrenOf(this.tree, node.id).length === 0;
    return drop
      ? ops.remove(node.id)
      : ops.update(node.id, { liveTabId: undefined, liveWindowId: undefined });
  }

  /** Move a live tab node so the tree order matches the browser order again. */
  private reconcilePosition(tabId: number): void {
    const record = this.tabs.get(tabId);
    if (!record) return;
    if (this.isConsistent(record.windowId)) return;
    const node = findByLiveTabId(this.tree, tabId);
    if (!node) return;
    const { parentId, index } = this.placementFor(record, node.id);
    if (node.parentId === parentId) {
      const currentIndex = childrenOf(this.tree, parentId).indexOf(node);
      if (currentIndex === index) return;
    }
    this.store.append([ops.move(node.id, parentId, index)]);
  }

  // -- startup --------------------------------------------------------------------------------

  /**
   * Rebuild live state from the browser (service worker restart, browser restart, first run).
   * Matches windows/tabs to existing nodes by live ids when they are still valid, otherwise by
   * URL overlap; everything that no longer exists becomes a saved node.
   */
  async rebuild(): Promise<RebuildReport> {
    const { tabs, windows } = await this.port.queryAll();
    return this.rebuildFrom(tabs, windows);
  }

  rebuildFrom(tabs: LiveTab[], windows: LiveWindow[]): RebuildReport {
    const report: RebuildReport = {
      windowsMatched: 0,
      windowsCreated: 0,
      tabsMatched: 0,
      tabsCreated: 0,
      nodesSaved: 0,
      nodesDropped: 0,
    };
    this.windowTabs.clear();
    this.tabs.clear();
    this.activeTabs.clear();
    this.knownWindows.clear();
    this.adoptTabs = [];
    this.adoptWindow = null;

    for (const w of windows) this.knownWindows.set(w.id, isTrackableWindow(w));
    const trackable = windows.filter(isTrackableWindow);
    const trackableIds = new Set(trackable.map((w) => w.id));
    const liveTabs = tabs
      .filter((t) => trackableIds.has(t.windowId))
      .sort((a, b) => a.windowId - b.windowId || a.index - b.index);
    for (const t of liveTabs) this.insertTabRecord(t);
    this.focusedWindowId = trackable.find((w) => w.focused)?.id;

    const tree = this.tree;
    const index = buildChildIndex(tree);
    const usedWindowNodes = new Set<NodeId>();
    const usedTabNodes = new Set<NodeId>();
    const batch: OpBody[] = [];

    const windowNodes = [...tree.values()].filter((n) => n.kind === "window");
    const tabNodes = [...tree.values()].filter((n) => n.kind === "tab");
    /**
     * Tab nodes that belong to a window node: its descendants plus any tab node anywhere in the
     * tree that still carries the window's live id. Drag-and-drop lets a live tab sit outside its
     * window's subtree (in a root group, under a saved window...) while the browser tab stays in
     * the window; those nodes must be re-matched too or the rebuild duplicates them.
     */
    const tabNodesOf = (win: TreeNode): TreeNode[] => {
      const out = descendantIds(tree, win.id, index)
        .map((id) => tree.get(id))
        .filter((n): n is TreeNode => n !== undefined && n.kind === "tab");
      if (win.liveWindowId === undefined) return out;
      const seen = new Set(out.map((n) => n.id));
      for (const n of tabNodes) {
        if (n.liveWindowId === win.liveWindowId && !seen.has(n.id)) out.push(n);
      }
      return out;
    };

    interface Assignment {
      node: TreeNode | null;
      tabs: LiveTab[];
      /** Live ids inside this window are trusted (same browser session). */
      idsValid: boolean;
    }
    const windowAssignments = new Map<number, Assignment>();
    for (const w of trackable) {
      const wTabs = liveTabs.filter((t) => t.windowId === w.id);
      let match: TreeNode | undefined;
      let idsValid = false;
      // 1. Same live id, verified by at least one tab id still matching with the same url (a
      //    blank page on both sides counts: a window holding only a new tab must re-attach too).
      const byId = windowNodes.find((n) => n.liveWindowId === w.id && !usedWindowNodes.has(n.id));
      if (byId) {
        const kids = tabNodesOf(byId);
        const samePage = (t: LiveTab, k: TreeNode) =>
          sameUrl(t.url, k.url) || (isBlankUrl(t.url) && isBlankUrl(k.url));
        const verified =
          kids.some((k) => wTabs.some((t) => t.id === k.liveTabId && samePage(t, k))) ||
          (kids.length === 0 && wTabs.every((t) => isBlankUrl(t.url)));
        if (verified) {
          match = byId;
          idsValid = true;
        }
      }
      // 2. URL overlap with a window node (session restore gives new ids).
      if (!match && wTabs.some((t) => !isBlankUrl(t.url))) {
        let best: { node: TreeNode; score: number } | undefined;
        for (const n of windowNodes) {
          if (usedWindowNodes.has(n.id)) continue;
          const urls = tabNodesOf(n).map((k) => k.url);
          const score = wTabs.filter((t) => urls.some((u) => sameUrl(u, t.url))).length;
          if (score > 0 && (!best || score > best.score)) best = { node: n, score };
        }
        const meaningful = wTabs.filter((t) => !isBlankUrl(t.url)).length;
        if (best && best.score >= Math.max(1, Math.ceil(meaningful / 2))) match = best.node;
      }
      if (match) {
        usedWindowNodes.add(match.id);
        report.windowsMatched++;
        if (match.liveWindowId !== w.id) batch.push(ops.update(match.id, { liveWindowId: w.id }));
        windowAssignments.set(w.id, { node: match, tabs: wTabs, idsValid });
      } else {
        report.windowsCreated++;
        windowAssignments.set(w.id, { node: null, tabs: wTabs, idsValid: false });
      }
    }

    // Everything still carrying a live id that we did not just confirm becomes saved.
    for (const n of tree.values()) {
      if (n.kind === "window" && n.liveWindowId !== undefined && !usedWindowNodes.has(n.id)) {
        batch.push(ops.update(n.id, { liveWindowId: undefined }));
        report.nodesSaved++;
      }
    }

    // Apply window-level ops first so tab placement sees consistent window nodes.
    if (batch.length) this.store.append(batch.splice(0));

    for (const [windowId, assignment] of windowAssignments) {
      // `assignment.node` is the pre-update snapshot, so `tabNodesOf` sees the id the window node
      // carried before this rebuild (the one its stray tab nodes still reference). A window that
      // did not match has no nodes to offer; its tabs are all created below.
      const candidates = assignment.node ? tabNodesOf(assignment.node) : [];
      if (!assignment.node) this.windowNodeFor(windowId);
      const free = (k: TreeNode) => !usedTabNodes.has(k.id);
      const tabBatch: OpBody[] = [];
      const deferred: LiveTab[] = [];
      for (const t of assignment.tabs) {
        const node =
          (assignment.idsValid
            ? candidates.find((k) => free(k) && k.liveTabId === t.id)
            : undefined) ??
          candidates.find((k) => free(k) && k.liveTabId === undefined && sameUrl(k.url, t.url)) ??
          candidates.find((k) => free(k) && sameUrl(k.url, t.url));
        if (node) {
          usedTabNodes.add(node.id);
          report.tabsMatched++;
          const patch = this.patchFor(node, t);
          if (patch) tabBatch.push(ops.update(node.id, patch));
        } else {
          deferred.push(t);
        }
      }
      if (tabBatch.length) this.store.append(tabBatch);
      for (const t of deferred) {
        report.tabsCreated++;
        usedTabNodes.add(this.adoptOrCreate(t));
      }
    }

    // Stale live tab nodes -> saved (or dropped when blank).
    const cleanup: OpBody[] = [];
    for (const n of this.tree.values()) {
      if (n.kind !== "tab" || n.liveTabId === undefined || usedTabNodes.has(n.id)) continue;
      const op = this.saveOrDrop(n);
      if (op.type === "remove") report.nodesDropped++;
      else report.nodesSaved++;
      cleanup.push(op);
    }
    if (cleanup.length) this.store.append(cleanup);
    return report;
  }

  // -- user actions ---------------------------------------------------------------------------

  liveTabIdsIn(nodeId: NodeId): number[] {
    const tree = this.tree;
    const ids: number[] = [];
    const self = tree.get(nodeId);
    if (!self) return ids;
    if (self.kind === "tab" && self.liveTabId !== undefined) ids.push(self.liveTabId);
    for (const id of descendantIds(tree, nodeId)) {
      const n = tree.get(id);
      if (n?.kind === "tab" && n.liveTabId !== undefined) ids.push(n.liveTabId);
    }
    return ids;
  }

  async focus(nodeId: NodeId): Promise<void> {
    const node = this.tree.get(nodeId);
    if (!node) return;
    if (node.kind === "tab" && node.liveTabId !== undefined && node.liveWindowId !== undefined) {
      await this.port.focusTab(node.liveTabId, node.liveWindowId);
      return;
    }
    if (node.kind === "window" && node.liveWindowId !== undefined) {
      const active = this.activeTabs.get(node.liveWindowId) ?? this.orderOf(node.liveWindowId)[0];
      if (active !== undefined) await this.port.focusTab(active, node.liveWindowId);
    }
  }

  /** Close the live tabs in a subtree; the resulting events turn them into saved nodes. */
  async closeAndSave(nodeId: NodeId): Promise<number> {
    const ids = this.liveTabIdsIn(nodeId);
    if (ids.length) await this.port.removeTabs(ids);
    return ids.length;
  }

  /**
   * Panic button. Marks everything saved *first* and flushes, then closes tabs. A blank tab is
   * opened in the current window so the browser (and this extension) stay alive.
   */
  async closeAllAndSave(): Promise<number> {
    const tree = this.tree;
    const batch: OpBody[] = [];
    const tabIds: number[] = [];
    for (const n of tree.values()) {
      if (n.kind === "tab" && n.liveTabId !== undefined) {
        tabIds.push(n.liveTabId);
        batch.push(this.saveOrDrop(n));
      } else if (n.kind === "window" && n.liveWindowId !== undefined) {
        batch.push(ops.update(n.id, { liveWindowId: undefined }));
      }
    }
    if (batch.length) this.store.append(batch);
    await this.store.compact(true);
    const windowId = this.focusedWindowId ?? (await this.port.currentWindowId());
    const keepAlive = await this.port.createTab({ url: "about:blank", windowId, active: true });
    const toClose = new Set(tabIds);
    for (const t of this.tabs.values()) toClose.add(t.id);
    toClose.delete(keepAlive.id);
    if (toClose.size) await this.port.removeTabs([...toClose]);
    // Windows other than the keep-alive one close with their tabs; drop empty window nodes.
    const leftovers: OpBody[] = [];
    const index = buildChildIndex(this.tree);
    for (const n of this.tree.values()) {
      if (n.kind === "window" && n.liveWindowId === undefined && !index.has(n.id)) {
        leftovers.push(ops.remove(n.id));
      }
    }
    if (leftovers.length) this.store.append(leftovers);
    return toClose.size;
  }

  private savedDescendantByUrl(
    rootId: NodeId,
    url: string,
    used: Set<NodeId>,
  ): TreeNode | undefined {
    const tree = this.tree;
    for (const id of descendantIds(tree, rootId)) {
      const n = tree.get(id);
      if (
        n &&
        n.kind === "tab" &&
        n.liveTabId === undefined &&
        !used.has(id) &&
        sameUrl(n.url, url)
      ) {
        return n;
      }
    }
    return undefined;
  }

  /** Reopen a saved node: a tab opens in its (live) window or the current one; a window reopens. */
  async restore(nodeId: NodeId): Promise<void> {
    const node = this.tree.get(nodeId);
    if (!node) return;
    if (node.kind === "tab") {
      if (node.liveTabId !== undefined) return this.focus(nodeId);
      if (!node.url) return;
      const windowNode = windowNodeOf(this.tree, nodeId);
      const windowId =
        windowNode?.liveWindowId ?? this.focusedWindowId ?? (await this.port.currentWindowId());
      this.adoptTabs.push({ nodeId, url: node.url, windowId });
      const tab = await this.port.createTab({ url: node.url, windowId, active: true });
      this.finishTabAdoption(nodeId, tab);
      return;
    }
    if (node.kind === "window") {
      if (node.liveWindowId !== undefined) return this.focus(nodeId);
      const urls = descendantIds(this.tree, nodeId)
        .map((id) => this.tree.get(id))
        .filter(
          (n): n is TreeNode => !!n && n.kind === "tab" && n.liveTabId === undefined && !!n.url,
        )
        .map((n) => n.url as string);
      if (!urls.length) return;
      this.adoptWindow = { nodeId, urls };
      const { window: win, tabs } = await this.port.createWindow(urls);
      this.adoptWindow = null;
      const current = this.tree.get(nodeId);
      if (current && current.liveWindowId === undefined) {
        this.store.append([ops.update(nodeId, { liveWindowId: win.id })]);
      }
      const used = new Set<NodeId>();
      for (const t of tabs) {
        const url = t.pendingUrl || t.url;
        const target = url ? this.savedDescendantByUrl(nodeId, url, used) : undefined;
        if (target) {
          used.add(target.id);
          this.finishTabAdoption(target.id, t);
        }
      }
      this.adoptTabs = this.adoptTabs.filter((a) => a.windowId !== win.id);
      return;
    }
    // group / note: open every saved tab beneath it in the current window.
    const windowId = this.focusedWindowId ?? (await this.port.currentWindowId());
    for (const id of descendantIds(this.tree, nodeId)) {
      const n = this.tree.get(id);
      if (n && n.kind === "tab" && n.liveTabId === undefined && n.url) {
        this.adoptTabs.push({ nodeId: id, url: n.url, windowId });
        const tab = await this.port.createTab({ url: n.url, windowId, active: false });
        this.finishTabAdoption(id, tab);
      }
    }
  }

  /** After `tabs.create` resolves make sure the saved node (not a duplicate) owns the tab. */
  private finishTabAdoption(nodeId: NodeId, tab: LiveTab): void {
    this.adoptTabs = this.adoptTabs.filter((a) => a.nodeId !== nodeId);
    const tree = this.tree;
    const node = tree.get(nodeId);
    if (!node) return;
    if (node.liveTabId === tab.id) return;
    const duplicate = findByLiveTabId(tree, tab.id);
    const batch: OpBody[] = [];
    if (duplicate && duplicate.id !== nodeId) {
      for (const kid of childrenOf(tree, duplicate.id)) {
        batch.push(ops.move(kid.id, nodeId, childrenOf(tree, nodeId).length));
      }
      batch.push(ops.remove(duplicate.id));
    }
    if (batch.length) this.store.append(batch);
    if (!this.tabs.has(tab.id)) this.insertTabRecord(tab);
    this.adoptNode(this.tree.get(nodeId) ?? node, tab);
  }

  /**
   * Move a node from the UI. When a live tab lands in a different live window, or in a new
   * position among its window's live tabs, the browser tab follows.
   */
  async moveNode(nodeId: NodeId, parentId: NodeId | null, index: number): Promise<void> {
    const before = this.tree.get(nodeId);
    if (!before) return;
    this.store.append([ops.move(nodeId, parentId, index)]);
    if (before.kind !== "tab" || before.liveTabId === undefined) return;
    const targetWindow = windowNodeOf(this.tree, nodeId);
    if (!targetWindow || targetWindow.liveWindowId === undefined) return;
    const desired = this.liveOrderInTree(targetWindow);
    const targetIndex = desired.indexOf(before.liveTabId);
    if (targetIndex < 0) return;
    const record = this.tabs.get(before.liveTabId);
    const currentOrder = this.windowTabs.get(targetWindow.liveWindowId) ?? [];
    const sameWindow = record?.windowId === targetWindow.liveWindowId;
    if (sameWindow && currentOrder.indexOf(before.liveTabId) === targetIndex) return;
    await this.port.moveTab(before.liveTabId, targetWindow.liveWindowId, targetIndex);
  }
}

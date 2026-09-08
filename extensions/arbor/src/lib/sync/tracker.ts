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

/**
 * A restore in flight: the saved node that must own the tab `tabs.create` is about to produce.
 * Matched by window + url when `tabs.onCreated` fires (the tab id is not known yet), then
 * confirmed by tab id once `tabs.create` resolves. Forgotten after `ADOPTION_TTL_MS` so a create
 * that never came back cannot capture an unrelated tab later.
 */
interface TabAdoption {
  nodeId: NodeId;
  url: string;
  windowId: number | undefined;
  ts: number;
}

const ADOPTION_TTL_MS = 30_000;

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
 * - a live tab node has `liveTabId` and `liveWindowId`; the tracker creates it under the matching
 *   window node, but the user may drag it anywhere (see `isDetached`);
 * - a closed tab becomes a saved node (live ids cleared) unless it was a blank new tab; a saved
 *   node the user reopens becomes live again where it sits (same parent, position and children);
 * - the depth-first order of the live tab nodes attached to a window node follows the browser's
 *   tab strip (detached tabs skipped) whenever the tracker itself changed the tree; user nesting
 *   is preserved otherwise.
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

  /**
   * A live tab node whose nearest window ancestor is not the window node of the browser window
   * it lives in: the user dragged it out of its window's subtree (into a root group, under a
   * saved window, ...) while the browser tab stayed put. Such a node is detached from tab-strip
   * ordering: it stays where the user put it, keeps receiving live updates (title, url, favicon,
   * close) and is ignored when the strip order is mirrored into the window node. Dropping it back
   * under the window node re-attaches it. Nothing but an explicit user move re-parents it.
   */
  private isDetached(node: TreeNode, windowNode: TreeNode): boolean {
    return node.kind === "tab" && windowNodeOf(this.tree, node.id)?.id !== windowNode.id;
  }

  /**
   * Depth-first ids of the live tabs attached to a window node. Subtrees of nested window nodes
   * are skipped: their tabs are ordered by their own window (or detached from this one).
   */
  private attachedOrderInTree(windowNode: TreeNode): number[] {
    const index = buildChildIndex(this.tree);
    const out: number[] = [];
    const seen = new Set<NodeId>();
    const walk = (parentId: NodeId): void => {
      for (const n of index.get(parentId) ?? []) {
        if (n.kind === "window" || seen.has(n.id)) continue;
        seen.add(n.id);
        if (n.kind === "tab" && n.liveTabId !== undefined) out.push(n.liveTabId);
        walk(n.id);
      }
    };
    walk(windowNode.id);
    return out;
  }

  /** The browser's strip order minus detached tabs: the sequence the window node's subtree mirrors. */
  private attachedOrderInBrowser(windowId: number, windowNode: TreeNode): number[] {
    const tree = this.tree;
    return (this.windowTabs.get(windowId) ?? []).filter((id) => {
      const node = findByLiveTabId(tree, id);
      return !node || !this.isDetached(node, windowNode);
    });
  }

  private isConsistent(windowId: number): boolean {
    const windowNode = findWindowByLiveId(this.tree, windowId);
    if (!windowNode) return false;
    const inTree = this.attachedOrderInTree(windowNode);
    const inBrowser = this.attachedOrderInBrowser(windowId, windowNode);
    return inTree.length === inBrowser.length && inTree.every((id, i) => id === inBrowser[i]);
  }

  /** Where a tab at its current browser position should sit in the tree. */
  private placementFor(tab: LiveTab, excludeId?: NodeId): { parentId: NodeId; index: number } {
    const tree = this.tree;
    const windowNode = this.windowNodeFor(tab.windowId);
    if (tab.openerTabId !== undefined) {
      const opener = findByLiveTabId(tree, tab.openerTabId);
      if (opener && opener.id !== excludeId && !this.isDetached(opener, windowNode)) {
        const kids = childrenOf(tree, opener.id).filter((k) => k.id !== excludeId);
        return { parentId: opener.id, index: kids.length };
      }
    }
    // Right after the nearest left-hand neighbour that takes part in strip ordering. Detached
    // neighbours sit wherever the user put them and must not attract the tab there.
    const order = this.orderOf(tab.windowId);
    let appendAtEnd = false;
    for (let pos = order.indexOf(tab.id) - 1; pos >= 0; pos--) {
      const prev = findByLiveTabId(tree, order[pos] as number);
      if (!prev) {
        appendAtEnd = true; // a tab we hold no node for yet: keep the previous behaviour
        break;
      }
      // A root-level tab node has no window ancestor, so it is detached as well.
      if (prev.id === excludeId || prev.parentId === null || this.isDetached(prev, windowNode)) {
        continue;
      }
      const siblings = childrenOf(tree, prev.parentId).filter((s) => s.id !== excludeId);
      return { parentId: prev.parentId, index: siblings.indexOf(prev) + 1 };
    }
    return {
      parentId: windowNode.id,
      index: appendAtEnd ? childrenOf(tree, windowNode.id).length : 0,
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

  /** Restores still waiting for their tab, minus the ones that gave up (see `ADOPTION_TTL_MS`). */
  private pendingAdoptions(): TabAdoption[] {
    const cutoff = this.now() - ADOPTION_TTL_MS;
    if (this.adoptTabs.some((a) => a.ts < cutoff)) {
      this.adoptTabs = this.adoptTabs.filter((a) => a.ts >= cutoff);
    }
    return this.adoptTabs;
  }

  private adoptOrCreate(tab: LiveTab): NodeId {
    const tree = this.tree;
    const url = tab.pendingUrl || tab.url;
    const pending = this.pendingAdoptions();
    const adoptIdx = pending.findIndex(
      (a) => (a.windowId === undefined || a.windowId === tab.windowId) && sameUrl(a.url, url),
    );
    if (adoptIdx >= 0) {
      const [adoption] = pending.splice(adoptIdx, 1);
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

  /**
   * Bind a saved node to a live tab where the node sits. Nothing is moved: inside a live window's
   * subtree the tab was opened at the strip index matching the node (see `stripIndexFor`);
   * anywhere else (root group, saved window...) the node becomes a detached live tab and keeps its
   * parent, position and children. The window node is created on demand so the tab has a window
   * node to be attached to or detached from.
   */
  private adoptNode(node: TreeNode, tab: LiveTab): void {
    this.windowNodeFor(tab.windowId);
    const patch = this.patchFor(node, tab) ?? {};
    // Keep the saved title/favicon until the page reports its own.
    if (!tab.title) delete patch.title;
    if (!tab.favIconUrl) delete patch.favIconUrl;
    if (Object.keys(patch).length) this.store.append([ops.update(node.id, patch)]);
  }

  /**
   * Strip index at which the tab for saved `nodeId` (inside live `windowNode`'s subtree) must
   * open so the window's attached depth-first order keeps matching the strip: right after the
   * nearest attached predecessor still in the strip, else right before the nearest attached
   * successor, else at the end (`undefined`).
   */
  private stripIndexFor(
    nodeId: NodeId,
    windowNode: TreeNode,
    windowId: number,
  ): number | undefined {
    const index = buildChildIndex(this.tree);
    const before: number[] = [];
    const after: number[] = [];
    let passed = false;
    const seen = new Set<NodeId>();
    const walk = (parentId: NodeId): void => {
      for (const n of index.get(parentId) ?? []) {
        if (n.kind === "window" || seen.has(n.id)) continue;
        seen.add(n.id);
        if (n.id === nodeId) passed = true;
        else if (n.kind === "tab" && n.liveTabId !== undefined) {
          (passed ? after : before).push(n.liveTabId);
        }
        walk(n.id);
      }
    };
    walk(windowNode.id);
    const strip = this.orderOf(windowId);
    const pred = before.reverse().find((id) => strip.includes(id));
    if (pred !== undefined) return strip.indexOf(pred) + 1;
    const succ = after.find((id) => strip.includes(id));
    return succ === undefined ? undefined : strip.indexOf(succ);
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
    // A node the user had already detached from its old window stays where it is; one that sat
    // under its old window node follows the tab into the new window.
    const oldWindowNode =
      node.liveWindowId === undefined
        ? undefined
        : findWindowByLiveId(this.tree, node.liveWindowId);
    const wasDetached = oldWindowNode !== undefined && this.isDetached(node, oldWindowNode);
    if (!wasDetached && windowNodeOf(this.tree, node.id)?.id !== windowNode.id) {
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
            this.adoptTabs.push({ nodeId: target.id, url, windowId: win.id, ts: this.now() });
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
    if (this.isDetached(node, this.windowNodeFor(record.windowId))) return;
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

  /**
   * Reopen a saved node in place: the node itself becomes live again with the same parent,
   * position and children.
   *
   * - A tab node under a live window opens in that window at the strip index matching its place
   *   in the tree. Anywhere else (root group, saved window...) it opens in the focused window and
   *   becomes a detached live tab. Its saved children stay saved.
   * - A window node reopens as a new browser window whose tabs are its saved descendants.
   * - A group or note reopens every saved tab beneath it (each in place, as above).
   */
  async restore(nodeId: NodeId): Promise<void> {
    const node = this.tree.get(nodeId);
    if (!node) return;
    if (node.kind === "tab") {
      if (node.liveTabId !== undefined) return this.focus(nodeId);
      await this.reopenTab(node, true);
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
      let created: { window: LiveWindow; tabs: LiveTab[] };
      try {
        created = await this.port.createWindow(urls);
      } finally {
        this.adoptWindow = null;
      }
      const { window: win, tabs } = created;
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
      this.foldDuplicateWindowNodes(nodeId, win.id);
      return;
    }
    // group / note: open every saved tab beneath it.
    for (const id of descendantIds(this.tree, nodeId)) {
      const n = this.tree.get(id);
      if (n && n.kind === "tab" && n.liveTabId === undefined && n.url) {
        await this.reopenTab(n, false);
      }
    }
  }

  /** Open a browser tab for saved tab `node` so that `node` itself becomes live in place. */
  private async reopenTab(node: TreeNode, active: boolean): Promise<void> {
    if (!node.url) return;
    const windowNode = windowNodeOf(this.tree, node.id);
    const liveWindowId = windowNode?.liveWindowId;
    const windowId = liveWindowId ?? this.focusedWindowId ?? (await this.port.currentWindowId());
    const index =
      windowNode && liveWindowId !== undefined
        ? this.stripIndexFor(node.id, windowNode, liveWindowId)
        : undefined;
    const adoption: TabAdoption = { nodeId: node.id, url: node.url, windowId, ts: this.now() };
    this.adoptTabs.push(adoption);
    let tab: LiveTab;
    try {
      tab = await this.port.createTab({ url: node.url, windowId, index, active });
    } catch (e) {
      this.adoptTabs = this.adoptTabs.filter((a) => a !== adoption);
      throw e;
    }
    this.finishTabAdoption(node.id, tab);
  }

  /**
   * `tabs.onCreated` may reach us before `windows.onCreated` while a saved window reopens; the
   * tabs then conjure a second node for the new window. Fold it into the reopened node.
   */
  private foldDuplicateWindowNodes(keepId: NodeId, windowId: number): void {
    for (const dup of [...this.tree.values()]) {
      if (dup.kind !== "window" || dup.id === keepId || dup.liveWindowId !== windowId) continue;
      const batch: OpBody[] = [];
      let at = childrenOf(this.tree, keepId).length;
      for (const kid of childrenOf(this.tree, dup.id)) batch.push(ops.move(kid.id, keepId, at++));
      batch.push(ops.remove(dup.id));
      this.store.append(batch);
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
   * position among its window's attached live tabs, the browser tab follows. Dropping it outside
   * any live window's subtree detaches it from strip ordering and leaves the browser alone.
   */
  async moveNode(nodeId: NodeId, parentId: NodeId | null, index: number): Promise<void> {
    const before = this.tree.get(nodeId);
    if (!before) return;
    this.store.append([ops.move(nodeId, parentId, index)]);
    if (before.kind !== "tab" || before.liveTabId === undefined) return;
    const tabId = before.liveTabId;
    const targetWindow = windowNodeOf(this.tree, nodeId);
    if (!targetWindow || targetWindow.liveWindowId === undefined) return;
    const desired = this.attachedOrderInTree(targetWindow);
    const pos = desired.indexOf(tabId);
    if (pos < 0) return;
    const record = this.tabs.get(tabId);
    const currentOrder = this.windowTabs.get(targetWindow.liveWindowId) ?? [];
    const sameWindow = record?.windowId === targetWindow.liveWindowId;
    // Strip index = right after the nearest attached predecessor still in the strip (detached
    // tabs may sit anywhere in it), else right before the nearest attached successor.
    const others = currentOrder.filter((id) => id !== tabId);
    const pred = desired
      .slice(0, pos)
      .reverse()
      .find((id) => others.includes(id));
    const succ = desired.slice(pos + 1).find((id) => others.includes(id));
    let targetIndex: number;
    if (pred !== undefined) targetIndex = others.indexOf(pred) + 1;
    else if (succ !== undefined) targetIndex = others.indexOf(succ);
    else targetIndex = sameWindow ? currentOrder.indexOf(tabId) : others.length;
    if (sameWindow && currentOrder.indexOf(tabId) === targetIndex) return;
    await this.port.moveTab(tabId, targetWindow.liveWindowId, targetIndex);
  }
}

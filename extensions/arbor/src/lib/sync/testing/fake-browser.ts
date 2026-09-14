/**
 * Test double for the browser side of the tracker: a scriptable set of windows and tabs that
 * emits the same events Chrome would and implements `TabsPort`. Shared by the tracker, pruning
 * and undo flow tests. Not shipped.
 */

import {
  childrenOf,
  findByLiveTabId,
  findWindowByLiveId,
  makeNode,
  ops,
  resolveDrop,
  type NodeId,
} from "../../model";
import { MemoryTreeStore } from "../../store/memory";
import { TabTracker } from "../tracker";
import type { LiveTab, LiveWindow, TabsPort } from "../types";

export class FakeBrowser implements TabsPort {
  windows: LiveWindow[] = [];
  tabs: LiveTab[] = [];
  tracker!: TabTracker;
  nextId = 100;
  removed: number[] = [];
  moved: { tabId: number; windowId: number; index: number }[] = [];
  focused: { tabId: number; windowId: number }[] = [];

  private reindex(windowId: number): void {
    this.tabs.filter((t) => t.windowId === windowId).forEach((t, i) => (t.index = i));
  }

  addWindow(id = this.nextId++): LiveWindow {
    const w: LiveWindow = { id, type: "normal", focused: this.windows.length === 0 };
    this.windows.push(w);
    return w;
  }

  addTab(windowId: number, url: string, title = url, extra: Partial<LiveTab> = {}): LiveTab {
    const tab: LiveTab = {
      id: this.nextId++,
      windowId,
      index: this.tabs.filter((t) => t.windowId === windowId).length,
      url,
      title,
      ...extra,
    };
    this.tabs.push(tab);
    return tab;
  }

  // -- scripted events --------------------------------------------------------------------------

  openWindow(): LiveWindow {
    const w = this.addWindow();
    this.tracker.handleWindowCreated(w);
    return w;
  }

  openTab(windowId: number, url: string, title = url, extra: Partial<LiveTab> = {}): LiveTab {
    const tab = this.addTab(windowId, url, title, extra);
    this.tracker.handleTabCreated({ ...tab, url: undefined, pendingUrl: url, title: undefined });
    this.tracker.handleTabUpdated(tab.id, { ...tab });
    return tab;
  }

  /**
   * When set, closing a window's last tab also closes the window (`windows.onRemoved` right after
   * the tab's `tabs.onRemoved`), as Chrome does. Off by default: most tests want a window to
   * outlive its tabs so restores land back in it.
   */
  closeEmptyWindows = false;

  closeTab(tabId: number): void {
    const t = this.tabs.find((x) => x.id === tabId);
    if (!t) return;
    this.tabs = this.tabs.filter((x) => x.id !== tabId);
    this.reindex(t.windowId);
    this.tracker.handleTabRemoved(tabId);
    if (this.closeEmptyWindows && !this.tabs.some((x) => x.windowId === t.windowId)) {
      this.windows = this.windows.filter((w) => w.id !== t.windowId);
      this.tracker.handleWindowRemoved(t.windowId);
    }
  }

  closeWindow(windowId: number): void {
    for (const t of this.tabs.filter((x) => x.windowId === windowId)) this.closeTab(t.id);
    if (this.windows.some((w) => w.id === windowId)) {
      this.windows = this.windows.filter((w) => w.id !== windowId);
      this.tracker.handleWindowRemoved(windowId);
    }
  }

  moveTabInStrip(tabId: number, toIndex: number): void {
    const t = this.tabs.find((x) => x.id === tabId);
    if (!t) return;
    const inWindow = this.tabs.filter((x) => x.windowId === t.windowId && x.id !== tabId);
    inWindow.splice(toIndex, 0, t);
    this.tabs = [...this.tabs.filter((x) => x.windowId !== t.windowId), ...inWindow];
    this.reindex(t.windowId);
    this.tracker.handleTabMoved(tabId, { windowId: t.windowId, toIndex });
  }

  /** Open a tab at a given strip position (e.g. "open link in new tab" next to the current one). */
  openTabAt(windowId: number, index: number, url: string, title = url): LiveTab {
    const tab: LiveTab = { id: this.nextId++, windowId, index, url, title };
    const inWindow = this.tabs.filter((x) => x.windowId === windowId);
    inWindow.splice(index, 0, tab);
    this.tabs = [...this.tabs.filter((x) => x.windowId !== windowId), ...inWindow];
    this.reindex(windowId);
    this.tracker.handleTabCreated({ ...tab });
    return tab;
  }

  /** Drag a tab to another window in the browser: detach then attach, as Chrome fires them. */
  moveTabToWindow(tabId: number, windowId: number, index: number): void {
    const t = this.tabs.find((x) => x.id === tabId);
    if (!t) return;
    const oldWindowId = t.windowId;
    this.tabs = this.tabs.filter((x) => x.id !== tabId);
    this.reindex(oldWindowId);
    t.windowId = windowId;
    const inWindow = this.tabs.filter((x) => x.windowId === windowId);
    inWindow.splice(index, 0, t);
    this.tabs = [...this.tabs.filter((x) => x.windowId !== windowId), ...inWindow];
    this.reindex(windowId);
    this.tracker.handleTabDetached(tabId, { oldWindowId });
    this.tracker.handleTabAttached(tabId, { newWindowId: windowId, newPosition: index });
  }

  /** Live tab ids of a window in strip order. */
  stripOrder(windowId: number): number[] {
    return this.tabs.filter((t) => t.windowId === windowId).map((t) => t.id);
  }

  // -- TabsPort ---------------------------------------------------------------------------------

  async queryAll() {
    return { tabs: this.tabs.map((t) => ({ ...t })), windows: this.windows.map((w) => ({ ...w })) };
  }

  /** When set, `createWindow` fires the tab events before the window event. */
  tabsBeforeWindow = false;

  async createTab(opts: {
    url: string;
    windowId?: number | undefined;
    index?: number | undefined;
  }): Promise<LiveTab> {
    const windowId = opts.windowId ?? this.windows[0]?.id ?? this.addWindow().id;
    const inWindow = this.tabs.filter((t) => t.windowId === windowId);
    const at =
      opts.index === undefined
        ? inWindow.length
        : Math.max(0, Math.min(opts.index, inWindow.length));
    const tab: LiveTab = { id: this.nextId++, windowId, index: at, url: opts.url, title: "" };
    inWindow.splice(at, 0, tab);
    this.tabs = [...this.tabs.filter((t) => t.windowId !== windowId), ...inWindow];
    this.reindex(windowId);
    // Chrome fires onCreated (with pendingUrl) before the promise resolves.
    this.tracker.handleTabCreated({ ...tab, url: "", pendingUrl: opts.url, title: "" });
    return { ...tab, url: opts.url };
  }

  async createWindow(urls: string[]) {
    const w = this.addWindow();
    if (!this.tabsBeforeWindow) this.tracker.handleWindowCreated(w);
    const tabs = urls.map((u) => this.addTab(w.id, u, ""));
    for (const t of tabs) this.tracker.handleTabCreated({ ...t, pendingUrl: t.url, url: "" });
    if (this.tabsBeforeWindow) this.tracker.handleWindowCreated(w);
    return { window: w, tabs };
  }

  async removeTabs(ids: number[]) {
    this.removed.push(...ids);
    for (const id of ids) this.closeTab(id);
  }

  async focusTab(tabId: number, windowId: number) {
    this.focused.push({ tabId, windowId });
  }

  async moveTab(tabId: number, windowId: number, index: number) {
    this.moved.push({ tabId, windowId, index });
  }

  async currentWindowId() {
    return this.windows[0]?.id;
  }
}

// -- shared fixtures ----------------------------------------------------------------------------

let ids = 0;
/** Deterministic node ids: n1, n2, ... (reset by `setup`). */
export const newId = () => `n${++ids}`;

export async function setup() {
  ids = 0;
  const store = new MemoryTreeStore();
  await store.open();
  const fb = new FakeBrowser();
  const tracker = new TabTracker(store, fb, { newId, now: () => 1 });
  fb.tracker = tracker;
  return { store, fb, tracker };
}

export type Ctx = Awaited<ReturnType<typeof setup>>;

/** What the side panel does on drop: resolve the destination, then ask the tracker to move. */
export async function drop(
  ctx: Ctx,
  draggedId: NodeId,
  targetId: NodeId,
  pos: "before" | "after" | "inside",
): Promise<void> {
  const dest = resolveDrop(ctx.store.getTree(), draggedId, targetId, pos);
  if (!dest) throw new Error("drop refused");
  await ctx.tracker.moveNode(draggedId, dest.parentId, dest.index);
}

export const dropInside = (ctx: Ctx, draggedId: NodeId, targetId: NodeId) =>
  drop(ctx, draggedId, targetId, "inside");

export function addRootGroup(ctx: Ctx, id: NodeId): void {
  ctx.store.append([ops.add(makeNode({ id, parentId: null, kind: "group", title: id, ts: 1 }))]);
}

/** A saved tab node (e.g. imported or left behind by a closed tab) at the end of `parentId`. */
export function addSavedTab(ctx: Ctx, id: NodeId, parentId: NodeId, url: string, title = id): void {
  ctx.store.append([ops.add(makeNode({ id, parentId, kind: "tab", title, url, ts: 1 }))]);
}

/** Service-worker restart: a fresh tracker over the same op log and the same live browser. */
export async function restartWorker(ctx: Ctx) {
  const fresh = new TabTracker(ctx.store, ctx.fb, { newId, now: () => 1 });
  ctx.fb.tracker = fresh;
  const report = await fresh.rebuild();
  return { fresh, report };
}

/** Titles of a node's children, in order. */
export function titlesUnder(ctx: Ctx, parentId: NodeId | undefined): string[] {
  return childrenOf(ctx.store.getTree(), parentId ?? "").map((n) => n.title);
}

export const nodeOf = (ctx: Ctx, tab: LiveTab) => findByLiveTabId(ctx.store.getTree(), tab.id);
export const winNodeOf = (ctx: Ctx, w: LiveWindow) => findWindowByLiveId(ctx.store.getTree(), w.id);

/** Ids of every window node in the tree. */
export function windowNodeIds(ctx: Ctx): NodeId[] {
  return [...ctx.store.getTree().values()].filter((n) => n.kind === "window").map((n) => n.id);
}

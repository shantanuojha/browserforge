import { describe, expect, it } from "vitest";
import {
  childrenOf,
  findByLiveTabId,
  findWindowByLiveId,
  makeNode,
  ops,
  resolveDrop,
  type NodeId,
} from "../model";
import { MemoryTreeStore } from "../store/memory";
import { TabTracker } from "./tracker";
import type { LiveTab, LiveWindow, TabsPort } from "./types";

/** A scriptable browser: holds windows/tabs and emits the same events Chrome would. */
class FakeBrowser implements TabsPort {
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

  closeTab(tabId: number): void {
    const t = this.tabs.find((x) => x.id === tabId);
    if (!t) return;
    this.tabs = this.tabs.filter((x) => x.id !== tabId);
    this.reindex(t.windowId);
    this.tracker.handleTabRemoved(tabId);
  }

  closeWindow(windowId: number): void {
    for (const t of this.tabs.filter((x) => x.windowId === windowId)) this.closeTab(t.id);
    this.windows = this.windows.filter((w) => w.id !== windowId);
    this.tracker.handleWindowRemoved(windowId);
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

  // -- TabsPort ---------------------------------------------------------------------------------

  async queryAll() {
    return { tabs: this.tabs.map((t) => ({ ...t })), windows: this.windows.map((w) => ({ ...w })) };
  }

  async createTab(opts: { url: string; windowId?: number | undefined }): Promise<LiveTab> {
    const windowId = opts.windowId ?? this.windows[0]?.id ?? this.addWindow().id;
    const tab = this.addTab(windowId, opts.url, "");
    // Chrome fires onCreated (with pendingUrl) before the promise resolves.
    this.tracker.handleTabCreated({ ...tab, url: "", pendingUrl: opts.url, title: "" });
    return { ...tab, url: opts.url };
  }

  async createWindow(urls: string[]) {
    const w = this.addWindow();
    this.tracker.handleWindowCreated(w);
    const tabs = urls.map((u) => this.addTab(w.id, u, ""));
    for (const t of tabs) this.tracker.handleTabCreated({ ...t, pendingUrl: t.url, url: "" });
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

let ids = 0;
const newId = () => `n${++ids}`;

async function setup() {
  ids = 0;
  const store = new MemoryTreeStore();
  await store.open();
  const fb = new FakeBrowser();
  const tracker = new TabTracker(store, fb, { newId, now: () => 1 });
  fb.tracker = tracker;
  return { store, fb, tracker };
}

describe("TabTracker events", () => {
  it("mirrors a window and its tabs", async () => {
    const { store, fb } = await setup();
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    fb.openTab(w.id, "https://b.test/", "B");
    const tree = store.getTree();
    const winNode = findWindowByLiveId(tree, w.id);
    expect(winNode).toBeDefined();
    const kids = childrenOf(tree, winNode?.id ?? "");
    expect(kids.map((k) => [k.title, k.url, k.liveWindowId])).toEqual([
      ["A", "https://a.test/", w.id],
      ["B", "https://b.test/", w.id],
    ]);
  });

  it("creates the window node lazily when tabs arrive before windows.onCreated", async () => {
    const { store, fb } = await setup();
    const w = fb.addWindow();
    fb.openTab(w.id, "https://a.test/");
    expect(findWindowByLiveId(store.getTree(), w.id)).toBeDefined();
    fb.tracker.handleWindowCreated(w); // must not duplicate
    expect([...store.getTree().values()].filter((n) => n.kind === "window").length).toBe(1);
  });

  it("ignores tabs in popup and devtools windows", async () => {
    const { store, fb, tracker } = await setup();
    const popup: LiveWindow = { id: 77, type: "popup" };
    fb.windows.push(popup);
    tracker.handleWindowCreated(popup);
    fb.openTab(77, "https://accounts.test/oauth", "Sign in");
    expect(store.getTree().size).toBe(0);
    // Same on rebuild.
    await tracker.rebuild();
    expect(store.getTree().size).toBe(0);
  });

  it("nests tabs under their opener", async () => {
    const { store, fb } = await setup();
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    fb.openTab(w.id, "https://a.test/child", "child", { openerTabId: a.id });
    const tree = store.getTree();
    const aNode = findByLiveTabId(tree, a.id);
    expect(childrenOf(tree, aNode?.id ?? "").map((n) => n.title)).toEqual(["child"]);
  });

  it("places new tabs after their left-hand neighbour", async () => {
    const { store, fb } = await setup();
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    fb.openTab(w.id, "https://c.test/", "C");
    // Insert B between A and C in the tab strip.
    const b: LiveTab = { id: 999, windowId: w.id, index: 1, url: "https://b.test/", title: "B" };
    fb.tabs.splice(1, 0, b);
    fb.tabs.forEach((t, i) => (t.index = i));
    fb.tracker.handleTabCreated(b);
    const winNode = findWindowByLiveId(store.getTree(), w.id);
    expect(childrenOf(store.getTree(), winNode?.id ?? "").map((n) => n.title)).toEqual([
      "A",
      "B",
      "C",
    ]);
    expect(findByLiveTabId(store.getTree(), a.id)).toBeDefined();
  });

  it("updates title, url and favicon without duplicating nodes", async () => {
    const { store, fb } = await setup();
    const w = fb.openWindow();
    const t = fb.openTab(w.id, "https://a.test/", "A");
    fb.tracker.handleTabUpdated(t.id, {
      ...t,
      title: "A2",
      url: "https://a.test/2",
      favIconUrl: "https://a.test/f.ico",
    });
    const node = findByLiveTabId(store.getTree(), t.id);
    expect(node).toMatchObject({
      title: "A2",
      url: "https://a.test/2",
      favIconUrl: "https://a.test/f.ico",
    });
    expect(store.getTree().size).toBe(2);
  });

  it("turns closed tabs into saved nodes and drops blank ones", async () => {
    const { store, fb } = await setup();
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    const blank = fb.openTab(w.id, "chrome://newtab/", "New Tab");
    fb.closeTab(a.id);
    fb.closeTab(blank.id);
    const tree = store.getTree();
    const saved = [...tree.values()].filter((n) => n.kind === "tab");
    expect(saved.length).toBe(1);
    expect(saved[0]).toMatchObject({ title: "A", url: "https://a.test/" });
    expect(saved[0]?.liveTabId).toBeUndefined();
    expect(saved[0]?.liveWindowId).toBeUndefined();
  });

  it("keeps a closed window as a saved subtree", async () => {
    const { store, fb } = await setup();
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    fb.openTab(w.id, "https://b.test/", "B");
    fb.closeWindow(w.id);
    const tree = store.getTree();
    const windows = [...tree.values()].filter((n) => n.kind === "window");
    expect(windows.length).toBe(1);
    expect(windows[0]?.liveWindowId).toBeUndefined();
    expect(childrenOf(tree, windows[0]?.id ?? "").map((n) => n.title)).toEqual(["A", "B"]);
  });

  it("removes a closed window node that only held blank tabs", async () => {
    const { store, fb } = await setup();
    const w = fb.openWindow();
    fb.openTab(w.id, "chrome://newtab/", "New Tab");
    fb.closeWindow(w.id);
    expect(store.getTree().size).toBe(0);
  });

  it("follows tab strip reordering", async () => {
    const { store, fb } = await setup();
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    fb.openTab(w.id, "https://b.test/", "B");
    const c = fb.openTab(w.id, "https://c.test/", "C");
    fb.moveTabInStrip(c.id, 0);
    const winNode = findWindowByLiveId(store.getTree(), w.id);
    expect(childrenOf(store.getTree(), winNode?.id ?? "").map((n) => n.title)).toEqual([
      "C",
      "A",
      "B",
    ]);
  });

  it("does not undo user nesting when the browser order already matches", async () => {
    const { store, fb, tracker } = await setup();
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    const b = fb.openTab(w.id, "https://b.test/", "B");
    const aNode = findByLiveTabId(store.getTree(), a.id);
    const bNode = findByLiveTabId(store.getTree(), b.id);
    // User nests B under A in the panel: DFS order A, B still equals the strip.
    await tracker.moveNode(bNode?.id ?? "", aNode?.id ?? "", 0);
    expect(fb.moved).toEqual([]);
    // A no-op strip event must not flatten it.
    tracker.handleTabMoved(b.id, { windowId: w.id, toIndex: 1 });
    expect(store.getTree().get(bNode?.id ?? "")?.parentId).toBe(aNode?.id);
  });

  it("moves the browser tab when the node is dragged across live windows", async () => {
    const { store, fb, tracker } = await setup();
    const w1 = fb.openWindow();
    const w2 = fb.openWindow();
    const a = fb.openTab(w1.id, "https://a.test/", "A");
    fb.openTab(w2.id, "https://x.test/", "X");
    const aNode = findByLiveTabId(store.getTree(), a.id);
    const w2Node = findWindowByLiveId(store.getTree(), w2.id);
    await tracker.moveNode(aNode?.id ?? "", w2Node?.id ?? "", 0);
    expect(fb.moved).toEqual([{ tabId: a.id, windowId: w2.id, index: 0 }]);
    // The browser answers with detach/attach; the node stays where the user put it.
    tracker.handleTabDetached(a.id, { oldWindowId: w1.id });
    tracker.handleTabAttached(a.id, { newWindowId: w2.id, newPosition: 0 });
    const after = store.getTree().get(aNode?.id ?? "");
    expect(after?.parentId).toBe(w2Node?.id);
    expect(after?.liveWindowId).toBe(w2.id);
  });

  it("handles attach for a tab whose node is still in the old window", async () => {
    const { store, fb, tracker } = await setup();
    const w1 = fb.openWindow();
    const w2 = fb.openWindow();
    const a = fb.openTab(w1.id, "https://a.test/", "A");
    fb.openTab(w2.id, "https://x.test/", "X");
    tracker.handleTabDetached(a.id, { oldWindowId: w1.id });
    tracker.handleTabAttached(a.id, { newWindowId: w2.id, newPosition: 1 });
    const w2Node = findWindowByLiveId(store.getTree(), w2.id);
    expect(childrenOf(store.getTree(), w2Node?.id ?? "").map((n) => n.title)).toEqual(["X", "A"]);
  });

  it("tracks tab replacement (prerender) and activation", async () => {
    const { store, fb, tracker } = await setup();
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    tracker.handleTabReplaced(555, a.id);
    expect(findByLiveTabId(store.getTree(), 555)?.title).toBe("A");
    tracker.handleTabActivated({ tabId: 555, windowId: w.id });
    expect(tracker.getLiveState().activeTabIds).toEqual([555]);
  });
});

describe("TabTracker actions", () => {
  it("closeAndSave closes every live tab in the subtree", async () => {
    const { store, fb, tracker } = await setup();
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    const b = fb.openTab(w.id, "https://b.test/", "B", { openerTabId: a.id });
    const aNode = findByLiveTabId(store.getTree(), a.id);
    const n = await tracker.closeAndSave(aNode?.id ?? "");
    expect(n).toBe(2);
    expect(fb.removed.sort()).toEqual([a.id, b.id].sort());
    expect(store.getTree().get(aNode?.id ?? "")?.liveTabId).toBeUndefined();
  });

  it("restore reuses the saved node instead of creating a duplicate", async () => {
    const { store, fb, tracker } = await setup();
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    const aNode = findByLiveTabId(store.getTree(), a.id);
    store.append([ops.update(aNode?.id ?? "", { note: "important" })]);
    fb.closeTab(a.id);
    const sizeBefore = store.getTree().size;
    await tracker.restore(aNode?.id ?? "");
    const tree = store.getTree();
    expect(tree.size).toBe(sizeBefore);
    const restored = tree.get(aNode?.id ?? "");
    expect(restored?.liveTabId).toBeDefined();
    expect(restored?.note).toBe("important");
    expect(restored?.title).toBe("A"); // saved title kept until the page reports one
  });

  it("restore of a saved window reopens all its tabs onto the same nodes", async () => {
    const { store, fb, tracker } = await setup();
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    fb.openTab(w.id, "https://b.test/", "B");
    const winNode = findWindowByLiveId(store.getTree(), w.id);
    fb.closeWindow(w.id);
    await tracker.restore(winNode?.id ?? "");
    const tree = store.getTree();
    expect(tree.size).toBe(3);
    const win = tree.get(winNode?.id ?? "");
    expect(win?.liveWindowId).toBeDefined();
    for (const kid of childrenOf(tree, win?.id ?? "")) expect(kid.liveTabId).toBeDefined();
  });

  it("restore moves a tab from a closed window under the current live window", async () => {
    const { store, fb, tracker } = await setup();
    const w1 = fb.openWindow();
    const a = fb.openTab(w1.id, "https://a.test/", "A");
    const aNode = findByLiveTabId(store.getTree(), a.id);
    fb.closeWindow(w1.id);
    const w2 = fb.openWindow();
    fb.openTab(w2.id, "https://x.test/", "X");
    await tracker.restore(aNode?.id ?? "");
    const w2Node = findWindowByLiveId(store.getTree(), w2.id);
    expect(store.getTree().get(aNode?.id ?? "")?.parentId).toBe(w2Node?.id);
  });

  it("closeAllAndSave marks everything saved, keeps the browser alive and closes tabs", async () => {
    const { store, fb, tracker } = await setup();
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    const b = fb.openTab(w.id, "https://b.test/", "B");
    const n = await tracker.closeAllAndSave();
    expect(n).toBe(2);
    expect(fb.removed.sort()).toEqual([a.id, b.id].sort());
    const tree = store.getTree();
    const saved = [...tree.values()].filter((x) => x.kind === "tab" && x.url?.startsWith("https"));
    expect(saved.length).toBe(2);
    expect(saved.every((x) => x.liveTabId === undefined)).toBe(true);
    expect((await store.listSnapshots()).length).toBe(1); // pinned before closing
  });

  it("focus delegates to the port", async () => {
    const { store, fb, tracker } = await setup();
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    await tracker.focus(findByLiveTabId(store.getTree(), a.id)?.id ?? "");
    expect(fb.focused).toEqual([{ tabId: a.id, windowId: w.id }]);
  });
});

describe("TabTracker.rebuild", () => {
  it("builds the tree from scratch on first run", async () => {
    const { store, fb, tracker } = await setup();
    const w = fb.addWindow();
    fb.addTab(w.id, "https://a.test/", "A");
    fb.addTab(w.id, "https://b.test/", "B");
    const report = await tracker.rebuild();
    expect(report).toMatchObject({ windowsCreated: 1, tabsCreated: 2, tabsMatched: 0 });
    const winNode = findWindowByLiveId(store.getTree(), w.id);
    expect(childrenOf(store.getTree(), winNode?.id ?? "").map((n) => n.title)).toEqual(["A", "B"]);
  });

  it("re-attaches to existing nodes after a service-worker restart (ids valid)", async () => {
    const { store, fb } = await setup();
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    fb.openTab(w.id, "https://b.test/", "B");
    const aNode = findByLiveTabId(store.getTree(), a.id);
    store.append([ops.update(aNode?.id ?? "", { note: "n" })]);
    // A navigated while the worker was asleep.
    const live = fb.tabs.find((t) => t.id === a.id);
    if (live) live.url = "https://a.test/other";

    const fresh = new TabTracker(store, fb, { newId, now: () => 1 });
    const report = await fresh.rebuild();
    expect(report).toMatchObject({ windowsMatched: 1, tabsMatched: 2, tabsCreated: 0 });
    expect(store.getTree().get(aNode?.id ?? "")).toMatchObject({
      url: "https://a.test/other",
      note: "n",
      liveTabId: a.id,
    });
  });

  it("re-attaches a window that only holds a new tab instead of leaving a stale copy", async () => {
    const { store, fb } = await setup();
    const w = fb.openWindow();
    fb.openTab(w.id, "chrome://newtab/", "New tab");
    const winNode = findWindowByLiveId(store.getTree(), w.id);

    const fresh = new TabTracker(store, fb, { newId, now: () => 1 });
    const report = await fresh.rebuild();
    expect(report).toMatchObject({ windowsMatched: 1, windowsCreated: 0, nodesSaved: 0 });
    const windows = [...store.getTree().values()].filter((n) => n.kind === "window");
    expect(windows.map((n) => [n.id, n.liveWindowId])).toEqual([[winNode?.id, w.id]]);
  });

  it("matches windows by URL overlap after a browser restart (new ids)", async () => {
    const { store, fb } = await setup();
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    fb.openTab(w.id, "https://b.test/", "B");
    const oldWinNode = findWindowByLiveId(store.getTree(), w.id);
    // Browser restarted: same pages, all new ids.
    fb.windows = [];
    fb.tabs = [];
    const w2 = fb.addWindow(5000);
    fb.addTab(w2.id, "https://a.test/", "A");
    fb.addTab(w2.id, "https://b.test/", "B");
    fb.addTab(w2.id, "https://new.test/", "New");

    const fresh = new TabTracker(store, fb, { newId, now: () => 1 });
    const report = await fresh.rebuild();
    expect(report).toMatchObject({
      windowsMatched: 1,
      windowsCreated: 0,
      tabsMatched: 2,
      tabsCreated: 1,
    });
    expect(store.getTree().get(oldWinNode?.id ?? "")?.liveWindowId).toBe(w2.id);
    expect([...store.getTree().values()].filter((n) => n.kind === "window").length).toBe(1);
  });

  it("marks vanished tabs and windows as saved", async () => {
    const { store, fb } = await setup();
    const w1 = fb.openWindow();
    const w2 = fb.openWindow();
    fb.openTab(w1.id, "https://a.test/", "A");
    fb.openTab(w2.id, "https://b.test/", "B");
    // w2 disappeared while we were not looking; w1 lost its tab and got a new one.
    fb.windows = fb.windows.filter((w) => w.id !== w2.id);
    fb.tabs = fb.tabs.filter((t) => t.windowId !== w2.id && t.url !== "https://a.test/");
    fb.addTab(w1.id, "https://c.test/", "C");

    const fresh = new TabTracker(store, fb, { newId, now: () => 1 });
    const report = await fresh.rebuild();
    // w1's id cannot be verified (none of its tabs survived) so it is saved too, not reused.
    expect(report.nodesSaved).toBe(4); // windows w1 + w2, tabs A + B
    const tree = store.getTree();
    const live = [...tree.values()].filter((n) => n.liveTabId !== undefined);
    expect(live.map((n) => n.title)).toEqual(["C"]);
    const windows = [...tree.values()].filter((n) => n.kind === "window");
    expect(windows.length).toBe(3);
    expect(windows.filter((n) => n.liveWindowId !== undefined).length).toBe(1);
  });

  /** What the side panel does on drop: resolve the destination, then ask the tracker to move. */
  async function dropInside(
    ctx: Awaited<ReturnType<typeof setup>>,
    draggedId: NodeId,
    targetId: NodeId,
  ): Promise<void> {
    const dest = resolveDrop(ctx.store.getTree(), draggedId, targetId, "inside");
    if (!dest) throw new Error("drop refused");
    await ctx.tracker.moveNode(draggedId, dest.parentId, dest.index);
  }

  function addRootGroup(ctx: Awaited<ReturnType<typeof setup>>, id: NodeId): void {
    ctx.store.append([ops.add(makeNode({ id, parentId: null, kind: "group", title: id, ts: 1 }))]);
  }

  /** Service-worker restart: a fresh tracker over the same op log and the same live browser. */
  async function restartWorker(ctx: Awaited<ReturnType<typeof setup>>) {
    const fresh = new TabTracker(ctx.store, ctx.fb, { newId, now: () => 1 });
    ctx.fb.tracker = fresh;
    const report = await fresh.rebuild();
    return { fresh, report };
  }

  it("re-matches a live tab dragged into a root-level group after a worker restart", async () => {
    const ctx = await setup();
    const { store, fb } = ctx;
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    fb.openTab(w.id, "https://b.test/", "B");
    const aNode = findByLiveTabId(store.getTree(), a.id);
    addRootGroup(ctx, "g");
    await dropInside(ctx, aNode?.id ?? "", "g");
    expect(fb.moved).toEqual([]); // the browser tab stays in its window
    expect(store.getTree().get(aNode?.id ?? "")).toMatchObject({ parentId: "g", liveTabId: a.id });
    const sizeBefore = store.getTree().size;

    const { fresh, report } = await restartWorker(ctx);
    expect(report).toMatchObject({
      windowsMatched: 1,
      windowsCreated: 0,
      tabsMatched: 2,
      tabsCreated: 0,
      nodesSaved: 0,
    });
    const tree = store.getTree();
    expect(tree.size).toBe(sizeBefore);
    expect([...tree.values()].filter((n) => n.liveTabId === a.id).map((n) => n.id)).toEqual([
      aNode?.id,
    ]);
    expect(tree.get(aNode?.id ?? "")).toMatchObject({
      parentId: "g",
      liveTabId: a.id,
      liveWindowId: w.id,
    });
    // Later events keep landing on the moved node instead of a copy under the window.
    fresh.handleTabUpdated(a.id, { ...a, title: "A renamed" });
    expect(store.getTree().get(aNode?.id ?? "")?.title).toBe("A renamed");
    expect(store.getTree().size).toBe(sizeBefore);
  });

  it("re-attaches a window whose only tab was dragged into a root-level group", async () => {
    const ctx = await setup();
    const { store, fb } = ctx;
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    const aNode = findByLiveTabId(store.getTree(), a.id);
    const winNode = findWindowByLiveId(store.getTree(), w.id);
    addRootGroup(ctx, "g");
    await dropInside(ctx, aNode?.id ?? "", "g");
    const sizeBefore = store.getTree().size;

    const { report } = await restartWorker(ctx);
    // The window node is verified through its stray tab, not left as a stale saved copy.
    expect(report).toMatchObject({
      windowsMatched: 1,
      windowsCreated: 0,
      tabsMatched: 1,
      tabsCreated: 0,
      nodesSaved: 0,
    });
    const tree = store.getTree();
    expect(tree.size).toBe(sizeBefore);
    expect(tree.get(winNode?.id ?? "")?.liveWindowId).toBe(w.id);
    expect(tree.get(aNode?.id ?? "")).toMatchObject({ parentId: "g", liveTabId: a.id });
  });

  it("keeps a tab dragged into a group when a browser restart hands out new ids", async () => {
    const ctx = await setup();
    const { store, fb } = ctx;
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    fb.openTab(w.id, "https://b.test/", "B");
    const aNode = findByLiveTabId(store.getTree(), a.id);
    const winNode = findWindowByLiveId(store.getTree(), w.id);
    addRootGroup(ctx, "g");
    await dropInside(ctx, aNode?.id ?? "", "g");
    const sizeBefore = store.getTree().size;
    // Session restore: same pages, all new ids.
    fb.windows = [];
    fb.tabs = [];
    const w2 = fb.addWindow(5000);
    const a2 = fb.addTab(w2.id, "https://a.test/", "A");
    fb.addTab(w2.id, "https://b.test/", "B");

    const { report } = await restartWorker(ctx);
    expect(report).toMatchObject({ windowsMatched: 1, tabsMatched: 2, tabsCreated: 0 });
    const tree = store.getTree();
    expect(tree.size).toBe(sizeBefore);
    expect(tree.get(winNode?.id ?? "")?.liveWindowId).toBe(w2.id);
    expect(tree.get(aNode?.id ?? "")).toMatchObject({
      parentId: "g",
      liveTabId: a2.id,
      liveWindowId: w2.id,
    });
  });

  it("re-attaches a live window that was dragged into a group after a worker restart", async () => {
    const ctx = await setup();
    const { store, fb } = ctx;
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    fb.openTab(w.id, "https://b.test/", "B");
    const winNode = findWindowByLiveId(store.getTree(), w.id);
    addRootGroup(ctx, "g");
    await dropInside(ctx, winNode?.id ?? "", "g");
    expect(store.getTree().get(winNode?.id ?? "")?.parentId).toBe("g");
    const sizeBefore = store.getTree().size;

    const { fresh, report } = await restartWorker(ctx);
    expect(report).toMatchObject({
      windowsMatched: 1,
      windowsCreated: 0,
      tabsMatched: 2,
      tabsCreated: 0,
      nodesSaved: 0,
    });
    const tree = store.getTree();
    expect(tree.size).toBe(sizeBefore);
    expect([...tree.values()].filter((n) => n.kind === "window").map((n) => n.id)).toEqual([
      winNode?.id,
    ]);
    expect(tree.get(winNode?.id ?? "")).toMatchObject({ parentId: "g", liveWindowId: w.id });
    fresh.handleTabUpdated(a.id, { ...a, title: "A renamed" });
    expect(findByLiveTabId(store.getTree(), a.id)).toMatchObject({
      title: "A renamed",
      parentId: winNode?.id,
    });
    expect(store.getTree().size).toBe(sizeBefore);
  });

  it("does not trust colliding ids from a previous session", async () => {
    const { store } = await setup();
    // Persisted from an older session: window 1 with tab 7 pointing at a.test.
    const win = makeNode({
      id: "w",
      parentId: null,
      kind: "window",
      title: "Window",
      liveWindowId: 1,
      ts: 1,
    });
    const tab = makeNode({
      id: "t",
      parentId: "w",
      kind: "tab",
      title: "A",
      url: "https://a.test/",
      liveTabId: 7,
      liveWindowId: 1,
      ts: 1,
    });
    store.append([ops.add(win), ops.add(tab)]);
    const fb = new FakeBrowser();
    fb.addWindow(1);
    fb.addTab(1, "https://unrelated.test/", "U", { id: 7 });
    const tracker = new TabTracker(store, fb, { newId, now: () => 1 });
    fb.tracker = tracker;
    const report = await tracker.rebuild();
    expect(report.tabsMatched).toBe(0);
    expect(report.tabsCreated).toBe(1);
    expect(store.getTree().get("t")?.liveTabId).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { childrenOf, findByLiveTabId, findWindowByLiveId, makeNode, ops } from "../model";
import { MemoryTreeStore } from "../store/memory";
import {
  addGroup,
  addRootGroup,
  addSavedTab,
  boundNodeIds,
  drop,
  dropInside,
  FakeBrowser,
  newId,
  nodeOf,
  restartWorker,
  setup,
  titlesUnder,
  winNodeOf,
  type Ctx,
} from "./testing/fake-browser";
import { TabTracker } from "./tracker";
import type { LiveTab, LiveWindow } from "./types";

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

  it("restore of a tab from a closed window opens it in the current window but keeps it in place", async () => {
    const ctx = await setup();
    const { store, fb, tracker } = ctx;
    const w1 = fb.openWindow();
    const a = fb.openTab(w1.id, "https://a.test/", "A");
    const aNode = findByLiveTabId(store.getTree(), a.id);
    const w1Node = findWindowByLiveId(store.getTree(), w1.id);
    fb.closeWindow(w1.id);
    const w2 = fb.openWindow();
    fb.openTab(w2.id, "https://x.test/", "X");
    await tracker.restore(aNode?.id ?? "");
    // The browser tab lives in w2; the node stays under its saved window as a detached live tab.
    expect(fb.stripOrder(w2.id).length).toBe(2);
    expect(store.getTree().get(aNode?.id ?? "")).toMatchObject({
      parentId: w1Node?.id,
      liveWindowId: w2.id,
    });
    expect(store.getTree().get(w1Node?.id ?? "")?.liveWindowId).toBeUndefined();
    expect(titlesUnder(ctx, winNodeOf(ctx, w2)?.id)).toEqual(["X"]);
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

    const fresh = new TabTracker(store, fb, { newId, clock: () => 1 });
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

    const fresh = new TabTracker(store, fb, { newId, clock: () => 1 });
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

    const fresh = new TabTracker(store, fb, { newId, clock: () => 1 });
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

  it("re-attaches a window whose tabs are still loading (pendingUrl only) instead of duplicating it", async () => {
    // Seen in Chromium 153: a window opened with windows.create({ url }) while a resync ran had
    // url "" / pendingUrl set on every tab; the rebuild could not verify the window, created a
    // second container for it and left the first one unbound with two saved copies of its tabs.
    const { store, fb, tracker } = await setup();
    const w1 = fb.openWindow();
    fb.openTab(w1.id, "https://a.test/", "A");
    const w2 = fb.openWindow();
    const x = fb.addTab(w2.id, "https://x.test/", "");
    const y = fb.addTab(w2.id, "https://y.test/", "");
    for (const t of [x, y]) {
      t.pendingUrl = t.url;
      t.url = "";
      tracker.handleTabCreated({ ...t, title: undefined });
    }
    const before = store.getTree();
    const w2Node = findWindowByLiveId(before, w2.id);
    expect(childrenOf(before, w2Node?.id ?? "").map((n) => n.url)).toEqual([
      "https://x.test/",
      "https://y.test/",
    ]);

    // Resync while x and y are still committing.
    const report = tracker.rebuildFrom(
      fb.tabs.map((t) => ({ ...t })),
      fb.windows.map((w) => ({ ...w })),
    );
    expect(report).toMatchObject({
      windowsMatched: 2,
      windowsCreated: 0,
      tabsMatched: 3,
      tabsCreated: 0,
      nodesSaved: 0,
    });
    const tree = store.getTree();
    expect([...tree.values()].filter((n) => n.kind === "window").length).toBe(2);
    expect(tree.get(w2Node?.id ?? "")?.liveWindowId).toBe(w2.id);
    expect(nodeOf({ store, fb, tracker }, x)?.parentId).toBe(w2Node?.id);
    expect(nodeOf({ store, fb, tracker }, y)?.parentId).toBe(w2Node?.id);
    expect([...tree.values()].filter((n) => n.url === "https://x.test/").length).toBe(1);
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

    const fresh = new TabTracker(store, fb, { newId, clock: () => 1 });
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
    expect(boundNodeIds(ctx)).toEqual([winNode?.id]); // the group itself stays closed
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
    const tracker = new TabTracker(store, fb, { newId, clock: () => 1 });
    fb.tracker = tracker;
    const report = await tracker.rebuild();
    expect(report.tabsMatched).toBe(0);
    expect(report.tabsCreated).toBe(1);
    expect(store.getTree().get("t")?.liveTabId).toBeUndefined();
  });
});

/**
 * A live tab node dragged out of its window node's subtree (into a root group, under a saved
 * window...) is "detached" from strip ordering: it stays where the user put it, keeps its live
 * updates, and the window node mirrors the strip order of the remaining tabs around it.
 */
describe("TabTracker with detached tab nodes", () => {
  /** Window with A, B, C where A has been dragged into root group "g". */
  async function detachedSetup() {
    const ctx = await setup();
    const w = ctx.fb.openWindow();
    const a = ctx.fb.openTab(w.id, "https://a.test/", "A");
    const b = ctx.fb.openTab(w.id, "https://b.test/", "B");
    const c = ctx.fb.openTab(w.id, "https://c.test/", "C");
    addRootGroup(ctx, "g");
    await dropInside(ctx, nodeOf(ctx, a)?.id ?? "", "g");
    expect(ctx.fb.moved).toEqual([]); // no browser move: the tab is only detached in the tree
    expect(nodeOf(ctx, a)?.parentId).toBe("g");
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["B", "C"]);
    return { ...ctx, w, a, b, c };
  }

  it("leaves the grouped node alone and mirrors the strip when another tab is moved", async () => {
    const ctx = await detachedSetup();
    const { fb, w, a, b, c } = ctx;
    const aNode = nodeOf(ctx, a);
    fb.moveTabInStrip(c.id, 0); // strip: C A B
    expect(nodeOf(ctx, a)).toMatchObject({ id: aNode?.id, parentId: "g", liveTabId: a.id });
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["C", "B"]);
    fb.moveTabInStrip(b.id, 0); // strip: B C A
    expect(nodeOf(ctx, a)?.parentId).toBe("g");
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["B", "C"]);
    // Moving a tab right after the detached one must not drag it into the group.
    fb.moveTabInStrip(b.id, 2); // strip: C A B
    expect(titlesUnder(ctx, "g")).toEqual(["A"]);
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["C", "B"]);
    expect(fb.moved).toEqual([]);
  });

  it("moving the detached tab in the strip changes nothing in the tree", async () => {
    const ctx = await detachedSetup();
    const { fb, w, a } = ctx;
    const before = [...ctx.store.getTree().values()].map((n) => [n.id, n.parentId, n.order]);
    fb.moveTabInStrip(a.id, 2); // strip: B C A
    fb.moveTabInStrip(a.id, 1); // strip: B A C
    expect([...ctx.store.getTree().values()].map((n) => [n.id, n.parentId, n.order])).toEqual(
      before,
    );
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["B", "C"]);
  });

  it("places a created tab by its nearest attached neighbour, skipping detached ones", async () => {
    const ctx = await detachedSetup();
    const { fb, w, a } = ctx;
    // Strip: A N B C. A is detached, so N leads the window's own order.
    fb.openTabAt(w.id, 1, "https://n.test/", "N");
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["N", "B", "C"]);
    expect(titlesUnder(ctx, "g")).toEqual(["A"]);
    // Strip: A N B M C.
    fb.openTabAt(w.id, 3, "https://m.test/", "M");
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["N", "B", "M", "C"]);
    // A new tab right after the detached one goes to the front of the window, not into the group.
    fb.moveTabInStrip(a.id, 0); // strip: A N B M C (already there)
    fb.openTabAt(w.id, 1, "https://p.test/", "P"); // strip: A P N B M C
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["P", "N", "B", "M", "C"]);
    expect(titlesUnder(ctx, "g")).toEqual(["A"]);
  });

  it("re-attaches a node dropped back under its window and follows the strip again", async () => {
    const ctx = await detachedSetup();
    const { fb, w, a } = ctx;
    const winNode = winNodeOf(ctx, w);
    await dropInside(ctx, nodeOf(ctx, a)?.id ?? "", winNode?.id ?? ""); // appended: B C A
    expect(titlesUnder(ctx, winNode?.id)).toEqual(["B", "C", "A"]);
    // Re-attaching moves the browser tab to match the tree (final index after the move).
    expect(fb.moved).toEqual([{ tabId: a.id, windowId: w.id, index: 2 }]);
    fb.moveTabInStrip(a.id, 2); // the browser answers: B C A
    expect(titlesUnder(ctx, winNode?.id)).toEqual(["B", "C", "A"]);
    // From now on strip reorders apply to A again.
    fb.moveTabInStrip(a.id, 0); // strip: A B C
    expect(titlesUnder(ctx, winNode?.id)).toEqual(["A", "B", "C"]);
    expect(fb.moved.length).toBe(1);
  });

  it("stays consistent with a detached tab present: no-op strip events keep user nesting", async () => {
    const ctx = await detachedSetup();
    const { fb, tracker, w, b, c } = ctx;
    const bNode = nodeOf(ctx, b);
    const cNode = nodeOf(ctx, c);
    // User nests C under B: depth-first order B, C still equals the (attached) strip order.
    await tracker.moveNode(cNode?.id ?? "", bNode?.id ?? "", 0);
    expect(fb.moved).toEqual([]);
    // Were the window deemed inconsistent, reconciliation would flatten C next to B.
    tracker.handleTabMoved(c.id, { windowId: w.id, toIndex: 2 });
    tracker.handleTabMoved(b.id, { windowId: w.id, toIndex: 1 });
    expect(ctx.store.getTree().get(cNode?.id ?? "")?.parentId).toBe(bNode?.id);
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["B"]);
    expect(titlesUnder(ctx, "g")).toEqual(["A"]);
  });

  it("keeps live updates and close-to-saved for a detached tab", async () => {
    const ctx = await detachedSetup();
    const { fb, a } = ctx;
    const aNode = nodeOf(ctx, a);
    fb.tracker.handleTabUpdated(a.id, { ...a, title: "A2", favIconUrl: "https://a.test/f.ico" });
    expect(ctx.store.getTree().get(aNode?.id ?? "")).toMatchObject({
      parentId: "g",
      title: "A2",
      favIconUrl: "https://a.test/f.ico",
    });
    fb.closeTab(a.id);
    expect(ctx.store.getTree().get(aNode?.id ?? "")).toMatchObject({ parentId: "g", title: "A2" });
    expect(ctx.store.getTree().get(aNode?.id ?? "")?.liveTabId).toBeUndefined();
  });

  it("keeps a detached node in its group when the browser drags the tab to another window", async () => {
    const ctx = await detachedSetup();
    const { fb, w, a } = ctx;
    const w2 = fb.openWindow();
    const x = fb.openTab(w2.id, "https://x.test/", "X");
    fb.moveTabToWindow(a.id, w2.id, 1); // w2 strip: X A
    expect(nodeOf(ctx, a)).toMatchObject({ parentId: "g", liveWindowId: w2.id });
    expect(titlesUnder(ctx, winNodeOf(ctx, w2)?.id)).toEqual(["X"]);
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["B", "C"]);
    // ...and both windows keep mirroring their strips around it.
    const y = fb.openTabAt(w2.id, 2, "https://y.test/", "Y"); // w2 strip: X A Y
    expect(titlesUnder(ctx, winNodeOf(ctx, w2)?.id)).toEqual(["X", "Y"]);
    fb.moveTabInStrip(y.id, 0); // w2 strip: Y X A
    expect(titlesUnder(ctx, winNodeOf(ctx, w2)?.id)).toEqual(["Y", "X"]);
    expect(nodeOf(ctx, a)?.parentId).toBe("g");
    expect(nodeOf(ctx, x)?.parentId).toBe(winNodeOf(ctx, w2)?.id);
  });

  it("targets the strip index around detached tabs when a node is dropped in the panel", async () => {
    const ctx = await detachedSetup();
    const { fb, w, a, b, c } = ctx;
    const d = fb.openTab(w.id, "https://d.test/", "D"); // strip: A B C D, window node: B C D
    // Drop D before B: the strip index is B's (detached A stays in front).
    await drop(ctx, nodeOf(ctx, d)?.id ?? "", nodeOf(ctx, b)?.id ?? "", "before");
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["D", "B", "C"]);
    expect(fb.moved).toEqual([{ tabId: d.id, windowId: w.id, index: 1 }]);
    fb.moveTabInStrip(d.id, 1); // strip: A D B C
    // Drop B after C: right after C in the strip (final index 3).
    await drop(ctx, nodeOf(ctx, b)?.id ?? "", nodeOf(ctx, c)?.id ?? "", "after");
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["D", "C", "B"]);
    expect(fb.moved.at(-1)).toEqual({ tabId: b.id, windowId: w.id, index: 3 });
    fb.moveTabInStrip(b.id, 3); // strip: A D C B
    expect(fb.stripOrder(w.id)).toEqual([a.id, d.id, c.id, b.id]);
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["D", "C", "B"]);
    expect(nodeOf(ctx, a)?.parentId).toBe("g");
  });

  it("survives a worker restart without pulling the detached node back", async () => {
    const ctx = await detachedSetup();
    const { fb, w, a, c } = ctx;
    const { report } = await restartWorker(ctx);
    expect(report).toMatchObject({ tabsMatched: 3, tabsCreated: 0, nodesSaved: 0 });
    fb.moveTabInStrip(c.id, 0); // strip: C A B
    expect(nodeOf(ctx, a)?.parentId).toBe("g");
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["C", "B"]);
  });
});

/**
 * "Click it later to reopen it in place": restoring a saved node turns that very node live again
 * with the same parent, position and children. Outside a live window's subtree it becomes a
 * detached live tab; inside one the browser tab opens at the matching strip index.
 */
describe("TabTracker.restore in place", () => {
  /** Live window with A, B; root group "g" holding saved S (with saved child C) and saved T. */
  async function groupSetup() {
    const ctx = await setup();
    const w = ctx.fb.openWindow();
    const a = ctx.fb.openTab(w.id, "https://a.test/", "A");
    const b = ctx.fb.openTab(w.id, "https://b.test/", "B");
    addRootGroup(ctx, "g");
    addSavedTab(ctx, "s", "g", "https://s.test/", "S");
    addSavedTab(ctx, "c", "s", "https://c.test/", "C");
    addSavedTab(ctx, "t", "g", "https://t.test/", "T");
    return { ...ctx, w, a, b, size: ctx.store.getTree().size };
  }

  it("reopens a saved node inside a root group as a detached live tab, children kept", async () => {
    const ctx = await groupSetup();
    const { store, fb, tracker, w, a, b, size } = ctx;
    await tracker.restore("s");
    const tree = store.getTree();
    expect(tree.size).toBe(size);
    const s = tree.get("s");
    expect(s).toMatchObject({ parentId: "g", liveWindowId: w.id, title: "S" });
    expect(s?.liveTabId).toBeDefined();
    expect(titlesUnder(ctx, "g")).toEqual(["S", "T"]);
    expect(titlesUnder(ctx, "s")).toEqual(["C"]);
    expect(tree.get("c")?.liveTabId).toBeUndefined(); // the child stays saved
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["A", "B"]);
    // The browser tab opened in the focused window; the window keeps mirroring its strip around it.
    expect(fb.stripOrder(w.id)).toEqual([a.id, b.id, s?.liveTabId]);
    fb.moveTabInStrip(b.id, 0); // strip: B A S
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["B", "A"]);
    expect(store.getTree().get("s")?.parentId).toBe("g");
    expect(fb.moved).toEqual([]);
  });

  it("keeps applying live updates and saves the reopened node in place when it closes", async () => {
    const ctx = await groupSetup();
    const { store, fb, tracker, size } = ctx;
    await tracker.restore("s");
    const tabId = store.getTree().get("s")?.liveTabId ?? -1;
    const live = fb.tabs.find((t) => t.id === tabId);
    fb.tracker.handleTabUpdated(tabId, {
      ...(live as LiveTab),
      title: "S loaded",
      favIconUrl: "https://s.test/f.ico",
    });
    expect(store.getTree().get("s")).toMatchObject({
      parentId: "g",
      title: "S loaded",
      favIconUrl: "https://s.test/f.ico",
    });
    expect(store.getTree().size).toBe(size);
    fb.closeTab(tabId);
    const s = store.getTree().get("s");
    expect(s).toMatchObject({ parentId: "g", title: "S loaded" });
    expect(s?.liveTabId).toBeUndefined();
    expect(s?.liveWindowId).toBeUndefined();
    expect(titlesUnder(ctx, "s")).toEqual(["C"]);
    expect(store.getTree().size).toBe(size);
  });

  it("restoring the same node twice only focuses the live tab", async () => {
    const ctx = await groupSetup();
    const { store, fb, tracker, w } = ctx;
    await tracker.restore("s");
    const tabId = store.getTree().get("s")?.liveTabId;
    await tracker.restore("s");
    expect(fb.focused).toEqual([{ tabId, windowId: w.id }]);
    expect(fb.stripOrder(w.id).length).toBe(3);
  });

  it("restores a group (Enter) by opening it as a new window: same nodes, now bound", async () => {
    const ctx = await groupSetup();
    const { store, fb, tracker, w, size } = ctx;
    await tracker.restore("g");
    const tree = store.getTree();
    expect(tree.size).toBe(size);
    expect(fb.windows.length).toBe(2);
    const gWin = tree.get("g")?.liveWindowId;
    expect(gWin).toBe(fb.windows[1]?.id);
    for (const id of ["s", "c", "t"]) {
      expect(tree.get(id)?.liveTabId).toBeDefined();
      expect(tree.get(id)?.liveWindowId).toBe(gWin);
    }
    expect(titlesUnder(ctx, "g")).toEqual(["S", "T"]);
    expect(titlesUnder(ctx, "s")).toEqual(["C"]);
    // The other window is untouched; the new one holds the tabs in tree order.
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["A", "B"]);
    expect(fb.stripOrder(w.id).length).toBe(2);
    expect(fb.stripOrder(gWin ?? -1)).toEqual(["s", "c", "t"].map((id) => tree.get(id)?.liveTabId));
    // Now that it is bound, Enter focuses it instead of opening another window.
    await tracker.restore("g");
    expect(fb.windows.length).toBe(2);
    expect(fb.focused.at(-1)?.windowId).toBe(gWin);
  });

  it("reopenAll on a mixed group: closed tabs open in a new window, the open one is moved in, then close & save all unbinds it", async () => {
    const ctx = await groupSetup();
    ctx.fb.closeEmptyWindows = true;
    const { store, fb, tracker, w, a, b, size } = ctx;
    // Mixed group: T is already open (restored on its own into W), S and C are saved.
    await tracker.restore("t");
    const tTab = store.getTree().get("t")?.liveTabId ?? -1;
    expect(fb.stripOrder(w.id)).toEqual([a.id, b.id, tTab]);
    const before = [...store.getTree().values()].map((n) => [n.id, n.parentId, n.order]);

    const opened = await tracker.reopenAll("g");
    expect(opened).toBe(3); // S and C opened, T moved in
    const tree = store.getTree();
    expect(tree.size).toBe(size);
    // Same ids, same parents, same sibling order: nothing moved in the tree.
    expect([...tree.values()].map((n) => [n.id, n.parentId, n.order])).toEqual(before);
    const gWin = tree.get("g")?.liveWindowId as number;
    expect(fb.windows.map((x) => x.id)).toEqual([w.id, gWin]);
    for (const id of ["s", "c"]) {
      expect(tree.get(id)?.liveTabId).toBeDefined();
      expect(tree.get(id)?.liveWindowId).toBe(gWin);
    }
    // T keeps its tab; the browser was asked to move it behind S and C, where the tree has it.
    expect(tree.get("t")?.liveTabId).toBe(tTab);
    expect(fb.moved).toEqual([{ tabId: tTab, windowId: gWin, index: 2 }]);
    fb.moveTabToWindow(tTab, gWin, 2); // the browser answers with detach/attach
    expect(store.getTree().get("t")).toMatchObject({ parentId: "g", liveWindowId: gWin });
    expect(fb.stripOrder(gWin)).toEqual(
      ["s", "c", "t"].map((id) => store.getTree().get(id)?.liveTabId),
    );
    expect(fb.stripOrder(w.id)).toEqual([a.id, b.id]);
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["A", "B"]);
    // A second run has nothing left to do.
    expect(await tracker.reopenAll("g")).toBe(0);
    expect(fb.windows.length).toBe(2);

    // Close & save all on the group: its tabs close, the window goes, the group stays unbound
    // with every node in place as saved.
    const closed = await tracker.closeAndSave("g");
    expect(closed).toBe(3);
    expect(fb.windows.map((x) => x.id)).toEqual([w.id]);
    const after = store.getTree();
    expect(after.size).toBe(size);
    expect([...after.values()].map((n) => [n.id, n.parentId, n.order])).toEqual(before);
    expect(after.get("g")).toMatchObject({ kind: "window", title: "g" });
    expect(after.get("g")?.liveWindowId).toBeUndefined();
    for (const id of ["s", "c", "t"]) {
      expect(after.get(id)?.liveTabId).toBeUndefined();
      expect(after.get(id)?.liveWindowId).toBeUndefined();
    }
    expect(titlesUnder(ctx, "g")).toEqual(["S", "T"]);
    expect(titlesUnder(ctx, "s")).toEqual(["C"]);
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["A", "B"]);
  });

  it("reopenAll on a live window reopens its closed tabs at their strip positions", async () => {
    const ctx = await setup();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    const s1 = fb.openTab(w.id, "https://s1.test/", "S1");
    const b = fb.openTab(w.id, "https://b.test/", "B");
    const s2 = fb.openTab(w.id, "https://s2.test/", "S2");
    const winNode = winNodeOf(ctx, w);
    fb.closeTab(s1.id);
    fb.closeTab(s2.id); // W: A, S1(saved), B, S2(saved); strip: A B
    const size = store.getTree().size;
    expect(await tracker.reopenAll(winNode?.id ?? "")).toBe(2);
    const tree = store.getTree();
    expect(tree.size).toBe(size);
    expect(tree.get(winNode?.id ?? "")?.liveWindowId).toBe(w.id); // no new window
    const kids = childrenOf(tree, winNode?.id ?? "");
    expect(kids.map((k) => k.title)).toEqual(["A", "S1", "B", "S2"]);
    expect(kids.map((k) => k.liveTabId)).toEqual(fb.stripOrder(w.id));
    expect(fb.stripOrder(w.id)[0]).toBe(a.id);
    expect(fb.stripOrder(w.id)[2]).toBe(b.id);
  });

  it("reopenAll on a saved window reopens it as one new window", async () => {
    const ctx = await setup();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    fb.openTab(w.id, "https://b.test/", "B");
    const winNode = winNodeOf(ctx, w);
    fb.closeWindow(w.id);
    expect(await tracker.reopenAll(winNode?.id ?? "")).toBe(2);
    expect(fb.windows.length).toBe(1);
    const win = store.getTree().get(winNode?.id ?? "");
    expect(win?.liveWindowId).toBe(fb.windows[0]?.id);
    expect(childrenOf(store.getTree(), win?.id ?? "").every((k) => k.liveTabId !== undefined)).toBe(
      true,
    );
  });

  it("opens a saved node under a live window at the strip index matching the tree", async () => {
    const ctx = await setup();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    const s = fb.openTab(w.id, "https://s.test/", "S");
    const b = fb.openTab(w.id, "https://b.test/", "B");
    const sNode = nodeOf(ctx, s);
    fb.closeTab(s.id); // W: A, S(saved), B; strip: A B
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["A", "S", "B"]);
    await tracker.restore(sNode?.id ?? "");
    const restored = store.getTree().get(sNode?.id ?? "");
    expect(restored?.parentId).toBe(winNodeOf(ctx, w)?.id);
    expect(fb.stripOrder(w.id)).toEqual([a.id, restored?.liveTabId, b.id]);
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["A", "S", "B"]);
    // Tree and strip agree, so a no-op strip event changes nothing.
    fb.moveTabInStrip(b.id, 2);
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["A", "S", "B"]);
    expect(fb.moved).toEqual([]);
  });

  it("a group nested under an open window is a closed window of its own: tabs filed in it stay in place, Reopen all opens it as a window", async () => {
    // Row button, context menu, Enter and double-click all reach `restore`; the node must stay
    // inside its group (the 0.1.2 bug moved it under the window and the group looked emptied).
    const ctx = await setup();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    const s = fb.openTab(w.id, "https://s.test/", "S");
    const t = fb.openTab(w.id, "https://t.test/", "T");
    const b = fb.openTab(w.id, "https://b.test/", "B");
    const winNode = winNodeOf(ctx, w);
    // W: A, G[ S, T ], B  -- the user files S and T under a group inside the open window. The
    // group is a container without a window, so this is a tree-only move: the tabs stay put.
    addGroup(ctx, "g", winNode?.id ?? "", "G");
    await tracker.moveNode("g", winNode?.id ?? "", 1);
    await drop(ctx, nodeOf(ctx, s)?.id ?? "", "g", "inside");
    await drop(ctx, nodeOf(ctx, t)?.id ?? "", "g", "inside");
    expect(fb.moved).toEqual([]);
    expect(fb.stripOrder(w.id)).toEqual([a.id, s.id, t.id, b.id]);
    const sNode = nodeOf(ctx, s);
    const tNode = nodeOf(ctx, t);
    expect(titlesUnder(ctx, winNode?.id)).toEqual(["A", "G", "B"]);
    expect(titlesUnder(ctx, "g")).toEqual(["S", "T"]);
    // Close & save the group, then reopen one tab from inside it: it comes back in place in the
    // tree; the browser tab opens in the focused window (the group has none of its own).
    expect(await tracker.closeAndSave("g")).toBe(2);
    expect(store.getTree().get(sNode?.id ?? "")?.liveTabId).toBeUndefined();
    const size = store.getTree().size;
    await tracker.restore(sNode?.id ?? "");
    const tree = store.getTree();
    expect(tree.size).toBe(size);
    expect(tree.get(sNode?.id ?? "")).toMatchObject({ parentId: "g", liveWindowId: w.id });
    expect(tree.get(sNode?.id ?? "")?.liveTabId).toBeDefined();
    expect(tree.get(tNode?.id ?? "")?.liveTabId).toBeUndefined();
    expect(titlesUnder(ctx, "g")).toEqual(["S", "T"]);
    expect(titlesUnder(ctx, winNode?.id)).toEqual(["A", "G", "B"]);
    expect(fb.stripOrder(w.id)).toEqual([a.id, b.id, tree.get(sNode?.id ?? "")?.liveTabId]);
    // Reopen all on the group: T opens in a new window bound to the group and S is moved in.
    expect(await tracker.reopenAll("g")).toBe(2);
    const gWin = store.getTree().get("g")?.liveWindowId as number;
    expect(fb.windows.map((x) => x.id)).toEqual([w.id, gWin]);
    expect(store.getTree().get(tNode?.id ?? "")).toMatchObject({
      parentId: "g",
      liveWindowId: gWin,
    });
    expect(fb.moved).toEqual([
      { tabId: tree.get(sNode?.id ?? "")?.liveTabId, windowId: gWin, index: 0 },
    ]);
    expect(titlesUnder(ctx, "g")).toEqual(["S", "T"]);
    expect(titlesUnder(ctx, winNode?.id)).toEqual(["A", "G", "B"]);
  });

  it("opens a saved child of a live tab right after its parent in the strip", async () => {
    const ctx = await setup();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    const b = fb.openTab(w.id, "https://b.test/", "B");
    const c = fb.openTab(w.id, "https://c.test/", "C");
    addSavedTab(ctx, "s", nodeOf(ctx, a)?.id ?? "", "https://s.test/", "S"); // W: A > S, B, C
    await tracker.restore("s");
    const restored = store.getTree().get("s");
    expect(restored?.parentId).toBe(nodeOf(ctx, a)?.id);
    expect(fb.stripOrder(w.id)).toEqual([a.id, restored?.liveTabId, b.id, c.id]);
    // A saved node with no live predecessor opens in front of its successor.
    addSavedTab(ctx, "f", winNodeOf(ctx, w)?.id ?? "", "https://f.test/", "F");
    await tracker.moveNode("f", winNodeOf(ctx, w)?.id ?? "", 0); // W: F, A > S, B, C
    await tracker.restore("f");
    expect(fb.stripOrder(w.id)[0]).toBe(store.getTree().get("f")?.liveTabId);
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["F", "A", "B", "C"]);
  });

  it("reopens a saved window inside a group in place, children mapped to its tabs", async () => {
    const ctx = await setup();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    fb.openTab(w.id, "https://b.test/", "B");
    const winNode = winNodeOf(ctx, w);
    addRootGroup(ctx, "g");
    await dropInside(ctx, winNode?.id ?? "", "g");
    fb.closeWindow(w.id);
    expect(store.getTree().get(winNode?.id ?? "")).toMatchObject({ parentId: "g" });
    expect(store.getTree().get(winNode?.id ?? "")?.liveWindowId).toBeUndefined();
    const size = store.getTree().size;
    // Another window is focused meanwhile.
    const other = fb.openWindow();
    fb.openTab(other.id, "https://x.test/", "X");

    await tracker.restore(winNode?.id ?? "");
    const tree = store.getTree();
    expect(tree.size).toBe(size + 2);
    const win = tree.get(winNode?.id ?? "");
    expect(win?.parentId).toBe("g");
    expect(win?.liveWindowId).toBeDefined();
    expect(win?.liveWindowId).not.toBe(other.id);
    const kids = childrenOf(tree, winNode?.id ?? "");
    expect(kids.map((k) => k.title)).toEqual(["A", "B"]);
    expect(kids.map((k) => k.liveTabId)).toEqual(fb.stripOrder(win?.liveWindowId ?? -1));
    expect(kids.every((k) => k.liveWindowId === win?.liveWindowId)).toBe(true);
    expect(titlesUnder(ctx, winNodeOf(ctx, other)?.id)).toEqual(["X"]);
    // The reopened window keeps mirroring its strip.
    fb.moveTabInStrip(kids[1]?.liveTabId ?? -1, 0);
    expect(titlesUnder(ctx, winNode?.id)).toEqual(["B", "A"]);
    expect(store.getTree().get(winNode?.id ?? "")?.parentId).toBe("g");
  });

  it("folds a window node conjured by early tab events into the reopened window", async () => {
    const ctx = await setup();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    fb.openTab(w.id, "https://b.test/", "B");
    const winNode = winNodeOf(ctx, w);
    addRootGroup(ctx, "g");
    await dropInside(ctx, winNode?.id ?? "", "g");
    fb.closeWindow(w.id);
    const size = store.getTree().size;
    fb.tabsBeforeWindow = true;
    await tracker.restore(winNode?.id ?? "");
    const tree = store.getTree();
    expect(tree.size).toBe(size);
    expect(boundNodeIds(ctx)).toEqual([winNode?.id]);
    const win = tree.get(winNode?.id ?? "");
    expect(win?.parentId).toBe("g");
    const kids = childrenOf(tree, winNode?.id ?? "");
    expect(kids.map((k) => k.title)).toEqual(["A", "B"]);
    expect(kids.map((k) => k.liveTabId)).toEqual(fb.stripOrder(win?.liveWindowId ?? -1));
  });

  it("keeps the reopened node in its group across a worker restart", async () => {
    const ctx = await groupSetup();
    const { store, fb, tracker, w, size } = ctx;
    await tracker.restore("s");
    const tabId = store.getTree().get("s")?.liveTabId;
    const { fresh, report } = await restartWorker(ctx);
    expect(report).toMatchObject({
      windowsMatched: 1,
      windowsCreated: 0,
      tabsMatched: 3,
      tabsCreated: 0,
      nodesSaved: 0,
    });
    expect(store.getTree().size).toBe(size);
    expect(store.getTree().get("s")).toMatchObject({
      parentId: "g",
      liveTabId: tabId,
      liveWindowId: w.id,
    });
    expect(titlesUnder(ctx, "s")).toEqual(["C"]);
    const live = fb.tabs.find((t) => t.id === tabId);
    fresh.handleTabUpdated(tabId ?? -1, { ...(live as LiveTab), title: "S again" });
    expect(store.getTree().get("s")?.title).toBe("S again");
    expect(store.getTree().size).toBe(size);
  });

  it("binds the node by tab id when the created tab reports a different url", async () => {
    const ctx = await groupSetup();
    const { store, fb, tracker, w, size } = ctx;
    // The browser rewrites the url before onCreated (redirect, canonicalisation...).
    const createTab = fb.createTab.bind(fb);
    fb.createTab = async (opts) => {
      const tab = await createTab({ ...opts, url: "https://s.test/rewritten" });
      return { ...tab, url: "https://s.test/rewritten" };
    };
    await tracker.restore("s");
    const tree = store.getTree();
    expect(tree.size).toBe(size); // the placeholder the url mismatch created is gone again
    expect(tree.get("s")).toMatchObject({ parentId: "g", liveWindowId: w.id });
    expect(tree.get("s")?.liveTabId).toBeDefined();
    expect(titlesUnder(ctx, "s")).toEqual(["C"]);
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["A", "B"]);
  });

  it("forgets a pending restore when tabs.create fails", async () => {
    const ctx = await groupSetup();
    const { store, fb, tracker, w, size } = ctx;
    fb.createTab = async () => {
      throw new Error("no window");
    };
    await expect(tracker.restore("s")).rejects.toThrow("no window");
    expect(store.getTree().get("s")?.liveTabId).toBeUndefined();
    // A tab the user opens on the same url afterwards is a new node, not a hijacked S.
    fb.openTab(w.id, "https://s.test/", "S by hand");
    expect(store.getTree().size).toBe(size + 1);
    expect(store.getTree().get("s")?.liveTabId).toBeUndefined();
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["A", "B", "S by hand"]);
  });

  it("lets a stale pending restore expire instead of capturing a later tab", async () => {
    const store = new MemoryTreeStore();
    await store.open();
    const fb = new FakeBrowser();
    let clock = 1;
    const tracker = new TabTracker(store, fb, { newId, clock: () => clock });
    fb.tracker = tracker;
    const ctx: Ctx = { store, fb, tracker };
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    addRootGroup(ctx, "g");
    addSavedTab(ctx, "s", "g", "https://s.test/", "S");
    // tabs.create hangs (never resolves, never fires onCreated).
    fb.createTab = () => new Promise<LiveTab>(() => undefined);
    const hung = tracker.restore("s");
    await new Promise((r) => setTimeout(r, 0)); // the restore is now waiting on tabs.create
    clock += 60_000;
    fb.openTab(w.id, "https://s.test/", "S by hand");
    expect(store.getTree().get("s")?.liveTabId).toBeUndefined();
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["A", "S by hand"]);
    void hung;
  });
});

/**
 * Windows and groups are one structure: a container (`kind: "window"`) that is either bound to
 * an open browser window or not. "Reopen all" on an unbound container opens it as a window (closed
 * tabs open there, tabs open elsewhere are moved in); on a bound one it brings the closed tabs
 * back into that window in place. Nested containers are windows of their own.
 */
describe("containers: windows and groups are the same structure", () => {
  it("regression: a live tab dragged into a group, then closed, is reopened by the group's Reopen all together with the tabs that were there before", async () => {
    const ctx = await setup();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    const m = fb.openTab(w.id, "https://m.test/", "M");
    fb.openTab(w.id, "https://b.test/", "B");
    addRootGroup(ctx, "g");
    addSavedTab(ctx, "s", "g", "https://s.test/", "S"); // in the group all along
    const mNode = nodeOf(ctx, m) as NonNullable<ReturnType<typeof nodeOf>>;
    await dropInside(ctx, mNode.id, "g"); // filed under the group while open: tree-only move
    expect(fb.moved).toEqual([]);
    expect(titlesUnder(ctx, "g")).toEqual(["S", "M"]);

    fb.closeTab(m.id); // closed in the browser
    expect(store.getTree().get(mNode.id)).toMatchObject({ parentId: "g", url: "https://m.test/" });
    expect(store.getTree().get(mNode.id)?.liveTabId).toBeUndefined();

    expect(await tracker.reopenAll("g")).toBe(2);
    const gWin = store.getTree().get("g")?.liveWindowId as number;
    expect(fb.windows.map((x) => x.id)).toEqual([w.id, gWin]);
    for (const id of ["s", mNode.id]) {
      expect(store.getTree().get(id)).toMatchObject({ parentId: "g", liveWindowId: gWin });
      expect(store.getTree().get(id)?.liveTabId).toBeDefined();
    }
    expect(fb.stripOrder(gWin)).toEqual(
      ["s", mNode.id].map((id) => store.getTree().get(id)?.liveTabId),
    );
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["A", "B"]);
    expect(fb.stripOrder(w.id).length).toBe(2);
  });

  it("regression, bound container: a tab dragged in from another window, then closed, reopens in that window at its place", async () => {
    const ctx = await setup();
    const { store, fb, tracker } = ctx;
    const w1 = fb.openWindow();
    const w2 = fb.openWindow();
    const a = fb.openTab(w1.id, "https://a.test/", "A");
    const x = fb.openTab(w2.id, "https://x.test/", "X");
    fb.openTab(w2.id, "https://y.test/", "Y");
    const w1Node = winNodeOf(ctx, w1);
    // Dragging X after A under the open window W1 moves the real tab there.
    await drop(ctx, nodeOf(ctx, x)?.id ?? "", nodeOf(ctx, a)?.id ?? "", "after");
    expect(fb.moved).toEqual([{ tabId: x.id, windowId: w1.id, index: 1 }]);
    fb.moveTabToWindow(x.id, w1.id, 1);
    addSavedTab(ctx, "s", w1Node?.id ?? "", "https://s.test/", "S"); // W1: A, X, S
    expect(titlesUnder(ctx, w1Node?.id)).toEqual(["A", "X", "S"]);

    fb.closeTab(x.id);
    expect(nodeOf(ctx, x)).toBeUndefined();
    expect(await tracker.reopenAll(w1Node?.id ?? "")).toBe(2);
    expect(fb.windows.length).toBe(2); // no new window: the container is bound
    const kids = childrenOf(store.getTree(), w1Node?.id ?? "");
    expect(kids.map((k) => k.title)).toEqual(["A", "X", "S"]);
    expect(kids.map((k) => k.liveTabId)).toEqual(fb.stripOrder(w1.id));
    expect(kids.every((k) => k.liveWindowId === w1.id)).toBe(true);
  });

  it("regression: a tab node still claiming a tab the browser does not have counts as closed and is reopened", async () => {
    const ctx = await setup();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    addRootGroup(ctx, "g");
    addSavedTab(ctx, "s", "g", "https://s.test/", "S");
    // Its close event never reached us: the node looks open, the tab is long gone.
    store.append([
      ops.add(
        makeNode({
          id: "ghost",
          parentId: "g",
          kind: "tab",
          title: "Ghost",
          url: "https://ghost.test/",
          liveTabId: 999,
          liveWindowId: w.id,
          ts: 1,
        }),
      ),
    ]);
    expect(await tracker.reopenAll("g")).toBe(2);
    const gWin = store.getTree().get("g")?.liveWindowId as number;
    expect(fb.moved).toEqual([]); // nothing to move: 999 was not a tab anywhere
    expect(store.getTree().get("ghost")).toMatchObject({ parentId: "g", liveWindowId: gWin });
    expect(store.getTree().get("ghost")?.liveTabId).not.toBe(999);
    expect(fb.stripOrder(gWin).length).toBe(2);
  });

  it("regression: a container bound to a window the browser no longer has counts as closed and reopens as a fresh window", async () => {
    const ctx = await setup();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    // Its windows.onRemoved never reached us: the node still claims window 555.
    store.append([
      ops.add(
        makeNode({
          id: "stale",
          parentId: null,
          kind: "window",
          title: "Stale",
          liveWindowId: 555,
          ts: 1,
        }),
      ),
    ]);
    addSavedTab(ctx, "s", "stale", "https://s.test/", "S");
    await tracker.restore("stale"); // Enter: not a focus (nothing to focus), a reopen
    const win = store.getTree().get("stale")?.liveWindowId as number;
    expect(win).not.toBe(555);
    expect(fb.windows.map((x) => x.id)).toEqual([w.id, win]);
    expect(store.getTree().get("s")).toMatchObject({ liveWindowId: win });
    expect(fb.focused).toEqual([]);
  });

  it("Reopen all on an unbound container: tabs open elsewhere are moved into the new window at their tree positions", async () => {
    const ctx = await setup();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    const l1 = fb.openTab(w.id, "https://l1.test/", "L1");
    const l2 = fb.openTab(w.id, "https://l2.test/", "L2");
    addRootGroup(ctx, "g");
    addSavedTab(ctx, "s", "g", "https://s.test/", "S");
    await dropInside(ctx, nodeOf(ctx, l1)?.id ?? "", "g");
    addSavedTab(ctx, "t", "g", "https://t.test/", "T");
    await dropInside(ctx, nodeOf(ctx, l2)?.id ?? "", "g");
    expect(titlesUnder(ctx, "g")).toEqual(["S", "L1", "T", "L2"]);

    expect(await tracker.reopenAll("g")).toBe(4);
    const gWin = store.getTree().get("g")?.liveWindowId as number;
    // S and T were created in the new window; L1 goes between them, L2 after T.
    expect(fb.moved).toEqual([
      { tabId: l1.id, windowId: gWin, index: 1 },
      { tabId: l2.id, windowId: gWin, index: 3 },
    ]);
    fb.moveTabToWindow(l1.id, gWin, 1);
    fb.moveTabToWindow(l2.id, gWin, 3);
    expect(fb.stripOrder(gWin)).toEqual(
      ["s", nodeOf(ctx, l1)?.id, "t", nodeOf(ctx, l2)?.id].map(
        (id) => store.getTree().get(id ?? "")?.liveTabId,
      ),
    );
    expect(titlesUnder(ctx, "g")).toEqual(["S", "L1", "T", "L2"]);
    expect(store.getTree().get("g")?.title).toBe("g"); // the name stays when it opens
  });

  it("a group holding only open tabs can be opened as a window: its tabs are gathered there", async () => {
    const ctx = await setup();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    const b = fb.openTab(w.id, "https://b.test/", "B");
    const c = fb.openTab(w.id, "https://c.test/", "C");
    addRootGroup(ctx, "g");
    await dropInside(ctx, nodeOf(ctx, b)?.id ?? "", "g");
    await dropInside(ctx, nodeOf(ctx, c)?.id ?? "", "g");
    expect(await tracker.reopenAll("g")).toBe(2);
    const gWin = store.getTree().get("g")?.liveWindowId as number;
    expect(fb.windows.map((x) => x.id)).toEqual([w.id, gWin]);
    // The window was built around B (`windows.create({ tabId })`); C is moved in behind it.
    expect(nodeOf(ctx, b)).toMatchObject({ parentId: "g", liveWindowId: gWin });
    expect(fb.moved).toEqual([{ tabId: c.id, windowId: gWin, index: 1 }]);
    expect(fb.stripOrder(w.id)).toEqual([a.id, c.id]);
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["A"]);
  });

  it("Reopen all does not recurse into nested containers; each keeps its own Reopen", async () => {
    const ctx = await setup();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    addRootGroup(ctx, "g");
    addSavedTab(ctx, "s", "g", "https://s.test/", "S");
    addGroup(ctx, "inner", "g", "Inner");
    addSavedTab(ctx, "x", "inner", "https://x.test/", "X");
    addSavedTab(ctx, "t", "g", "https://t.test/", "T");

    expect(await tracker.reopenAll("g")).toBe(2); // S and T, not X
    const gWin = store.getTree().get("g")?.liveWindowId as number;
    expect(fb.stripOrder(gWin)).toEqual(["s", "t"].map((id) => store.getTree().get(id)?.liveTabId));
    expect(store.getTree().get("x")?.liveTabId).toBeUndefined();
    expect(store.getTree().get("inner")?.liveWindowId).toBeUndefined();
    expect(store.getTree().get("inner")).toMatchObject({ parentId: "g", title: "Inner" });

    // The nested container opens as a window of its own when the user asks for it.
    expect(await tracker.reopenAll("inner")).toBe(1);
    const innerWin = store.getTree().get("inner")?.liveWindowId as number;
    expect(innerWin).not.toBe(gWin);
    expect(fb.windows.map((x) => x.id)).toEqual([w.id, gWin, innerWin]);
    expect(store.getTree().get("x")).toMatchObject({ parentId: "inner", liveWindowId: innerWin });
    // Reopen all on the parent still has nothing to do with the nested window.
    expect(await tracker.reopenAll("g")).toBe(0);
  });

  it("Close all and save on a bound container unbinds it and keeps it, named, with its tabs saved in place", async () => {
    const ctx = await setup();
    ctx.fb.closeEmptyWindows = true;
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    fb.openTab(w.id, "https://b.test/", "B");
    const wNode = winNodeOf(ctx, w);
    expect(wNode).toMatchObject({ title: "" }); // a browser window: untitled, shown as "Window"
    store.append([ops.update(wNode?.id ?? "", { title: "Work" })]); // rename works while open
    const before = [...store.getTree().values()].map((n) => [n.id, n.parentId, n.order]);

    expect(await tracker.closeAndSave(wNode?.id ?? "")).toBe(2);
    expect(fb.windows).toEqual([]);
    const after = store.getTree();
    expect([...after.values()].map((n) => [n.id, n.parentId, n.order])).toEqual(before);
    expect(after.get(wNode?.id ?? "")).toMatchObject({ kind: "window", title: "Work" });
    expect(after.get(wNode?.id ?? "")?.liveWindowId).toBeUndefined();
    expect(childrenOf(after, wNode?.id ?? "").every((k) => k.liveTabId === undefined)).toBe(true);

    // Reopening it later brings the same nodes back as one window, still named.
    expect(await tracker.reopenAll(wNode?.id ?? "")).toBe(2);
    expect(store.getTree().get(wNode?.id ?? "")).toMatchObject({
      title: "Work",
      liveWindowId: fb.windows[0]?.id,
    });
  });

  it("an untitled browser window closed by the browser stays as a closed container while it holds tabs", async () => {
    const ctx = await setup();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    const wNode = winNodeOf(ctx, w);
    fb.closeWindow(w.id);
    expect(store.getTree().get(wNode?.id ?? "")).toMatchObject({ kind: "window", title: "" });
    expect(store.getTree().get(wNode?.id ?? "")?.liveWindowId).toBeUndefined();
    // ...and comes back as a window like any other container.
    expect(await tracker.reopenAll(wNode?.id ?? "")).toBe(1);
    expect(store.getTree().get(wNode?.id ?? "")?.liveWindowId).toBe(fb.windows[0]?.id);
  });

  it("focus moving to a popup or devtools window does not make it the target of the next restore", async () => {
    const ctx = await setup();
    const { fb, tracker } = ctx;
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    tracker.handleWindowFocusChanged(w.id);
    const popup: LiveWindow = { id: 77, type: "popup" };
    fb.windows.push(popup);
    tracker.handleWindowCreated(popup);
    tracker.handleWindowFocusChanged(77);
    expect(tracker.getLiveState().focusedWindowId).toBe(w.id);
    addRootGroup(ctx, "g");
    addSavedTab(ctx, "s", "g", "https://s.test/", "S");
    await tracker.restore("s");
    expect(fb.tabs.find((t) => t.url === "https://s.test/")?.windowId).toBe(w.id);
    expect(ctx.store.getTree().get("s")).toMatchObject({ parentId: "g", liveWindowId: w.id });
    // Losing focus altogether (no Chrome window focused) is still recorded.
    tracker.handleWindowFocusChanged(undefined);
    expect(tracker.getLiveState().focusedWindowId).toBeUndefined();
  });

  it("one tab that cannot be opened does not stop the others; the error is reported afterwards", async () => {
    const ctx = await setup();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    const wNode = winNodeOf(ctx, w);
    addSavedTab(ctx, "bad", wNode?.id ?? "", "chrome-extension://other/page.html", "Bad");
    addSavedTab(ctx, "s", wNode?.id ?? "", "https://s.test/", "S");
    const createTab = fb.createTab.bind(fb);
    fb.createTab = async (opts) => {
      if (opts.url.startsWith("chrome-extension://")) throw new Error("Cannot open that URL");
      return createTab(opts);
    };
    await expect(tracker.reopenAll(wNode?.id ?? "")).rejects.toThrow(
      /1 of 2 tabs could not be opened: Cannot open that URL/,
    );
    expect(store.getTree().get("s")?.liveTabId).toBeDefined();
    expect(store.getTree().get("bad")?.liveTabId).toBeUndefined();
    expect(titlesUnder(ctx, wNode?.id)).toEqual(["A", "Bad", "S"]);
  });

  it("windows the browser opens appear as untitled bound containers; a rename survives close and reopen", async () => {
    const ctx = await setup();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    const wNode = winNodeOf(ctx, w);
    expect(wNode).toMatchObject({ kind: "window", title: "", liveWindowId: w.id, parentId: null });
    store.append([ops.update(wNode?.id ?? "", { title: "Reading" })]);
    fb.closeWindow(w.id);
    expect(store.getTree().get(wNode?.id ?? "")).toMatchObject({ title: "Reading" });
    await tracker.restore(wNode?.id ?? "");
    expect(store.getTree().get(wNode?.id ?? "")).toMatchObject({
      title: "Reading",
      liveWindowId: fb.windows[0]?.id,
    });
    expect(boundNodeIds(ctx)).toEqual([wNode?.id]);
  });
});

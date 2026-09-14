import { describe, expect, it } from "vitest";
import { childrenOf, makeNode, ops, type TreeNode } from "../model";
import { MemoryTreeStore } from "../store/memory";
import {
  addRootGroup,
  addSavedTab,
  dropInside,
  FakeBrowser,
  newId,
  nodeOf,
  restartWorker,
  setup,
  titlesUnder,
  windowNodeIds,
  winNodeOf,
} from "./testing/fake-browser";
import { TabTracker } from "./tracker";

/**
 * Window nodes exist to hold tabs. Once nothing is left under one it is removed automatically
 * (logged as an ordinary remove op), unless its browser window is still open with at least one
 * tab. Groups and notes are the user's and are never pruned; a window holding one stays too.
 */
describe("empty window pruning", () => {
  /** Chrome closes a window with its last tab; every test here wants that behaviour. */
  async function realistic() {
    const ctx = await setup();
    ctx.fb.closeEmptyWindows = true;
    return ctx;
  }

  it("tab close: a window whose last tab closed is kept while it still holds a saved tab, pruned when it holds nothing", async () => {
    const ctx = await realistic();
    const { store, fb } = ctx;
    const w1 = fb.openWindow();
    const a = fb.openTab(w1.id, "https://a.test/", "A");
    const w1Node = winNodeOf(ctx, w1);
    fb.closeTab(a.id); // the window closes with it
    expect(store.getTree().get(w1Node?.id ?? "")).toMatchObject({ kind: "window" });
    expect(store.getTree().get(w1Node?.id ?? "")?.liveWindowId).toBeUndefined();
    expect(titlesUnder(ctx, w1Node?.id)).toEqual(["A"]);

    const w2 = fb.openWindow();
    const blank = fb.openTab(w2.id, "chrome://newtab/", "New Tab");
    const w2Node = winNodeOf(ctx, w2);
    fb.closeTab(blank.id); // blank tab dropped, window closed: nothing worth keeping
    expect(store.getTree().has(w2Node?.id ?? "")).toBe(false);
    expect(windowNodeIds(ctx)).toEqual([w1Node?.id]);
  });

  it("delete: removing the only tab node of a live window prunes the window in the same step", async () => {
    const ctx = await realistic();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    const aNode = nodeOf(ctx, a) as TreeNode;
    const wNode = winNodeOf(ctx, w) as TreeNode;
    const removed = await tracker.deleteNode(aNode.id);
    // Window first, then the deleted subtree: the order an undo re-adds them in.
    expect(removed.map((n) => n.id)).toEqual([wNode.id, aNode.id]);
    expect(store.getTree().size).toBe(0);
    expect(fb.removed).toEqual([a.id]);
    expect(fb.windows).toEqual([]); // the browser closed the window with its last tab
  });

  it("delete: a live window keeps its node while the real window still has a tab elsewhere in the tree", async () => {
    const ctx = await realistic();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    const b = fb.openTab(w.id, "https://b.test/", "B");
    const wNode = winNodeOf(ctx, w) as TreeNode;
    addRootGroup(ctx, "g");
    await dropInside(ctx, nodeOf(ctx, b)?.id ?? "", "g"); // B detached into a root group
    const removed = await tracker.deleteNode(nodeOf(ctx, a)?.id ?? "");
    expect(removed.map((n) => n.title)).toEqual(["A"]);
    // Zero children, but the browser window is open with B in it: the node stays, live.
    expect(store.getTree().get(wNode.id)).toMatchObject({ liveWindowId: w.id });
    expect(childrenOf(store.getTree(), wNode.id)).toEqual([]);
    // Once B closes (saved into its group) the window closes and the empty node goes.
    fb.closeTab(b.id);
    expect(store.getTree().has(wNode.id)).toBe(false);
    expect(titlesUnder(ctx, "g")).toEqual(["B"]);
    const savedB = childrenOf(store.getTree(), "g")[0];
    expect(savedB?.liveTabId).toBeUndefined();
    expect(store.getTree().size).toBe(2); // g + saved B
  });

  it("a window showing only a new-tab page is still a window: its node is not pruned", async () => {
    const ctx = await realistic();
    const { store, fb } = ctx;
    const w = fb.openWindow();
    const blank = fb.openTab(w.id, "chrome://newtab/", "New Tab");
    const wNode = winNodeOf(ctx, w) as TreeNode;
    addRootGroup(ctx, "g");
    await dropInside(ctx, nodeOf(ctx, blank)?.id ?? "", "g"); // node leaves, tab stays open
    expect(childrenOf(store.getTree(), wNode.id)).toEqual([]);
    expect(store.getTree().get(wNode.id)).toMatchObject({ liveWindowId: w.id });
    const { report } = await restartWorker(ctx);
    expect(report.windowsPruned).toBe(0);
    expect(store.getTree().get(wNode.id)).toMatchObject({ liveWindowId: w.id });
  });

  it("never prunes groups or notes, and keeps a window that still holds one", async () => {
    const ctx = await realistic();
    const { store, tracker } = ctx;
    // Saved window with a note and an empty group beneath it, plus one saved tab.
    store.append([
      ops.add(makeNode({ id: "w", parentId: null, kind: "window", title: "W", ts: 1 })),
      ops.add(makeNode({ id: "memo", parentId: "w", kind: "note", title: "memo", ts: 1 })),
      ops.add(makeNode({ id: "g", parentId: "w", kind: "group", title: "G", ts: 1 })),
    ]);
    addSavedTab(ctx, "s", "w", "https://s.test/", "S");
    expect((await tracker.deleteNode("s")).map((n) => n.id)).toEqual(["s"]);
    expect(store.getTree().has("w")).toBe(true);
    expect(titlesUnder(ctx, "w")).toEqual(["memo", "G"]);
    // The empty group and the note stay through a sweep as well.
    const { report } = await restartWorker(ctx);
    expect(report.windowsPruned).toBe(0);
    expect([...store.getTree().keys()].sort()).toEqual(["g", "memo", "w"]);
    // An empty root group is never touched either.
    addRootGroup(ctx, "root-group");
    addSavedTab(ctx, "t", "root-group", "https://t.test/", "T");
    await tracker.deleteNode("t");
    expect(store.getTree().has("root-group")).toBe(true);
  });

  it("move-out: dragging the last tab out of a saved window prunes it; out of a live window does not", async () => {
    const ctx = await realistic();
    const { store, fb, tracker } = ctx;
    addRootGroup(ctx, "g");
    store.append([
      ops.add(makeNode({ id: "saved-w", parentId: null, kind: "window", title: "W", ts: 1 })),
    ]);
    addSavedTab(ctx, "s", "saved-w", "https://s.test/", "S");
    const pruned = await tracker.moveNode("s", "g", 0);
    expect(pruned.map((n) => n.id)).toEqual(["saved-w"]);
    expect(store.getTree().has("saved-w")).toBe(false);
    expect(titlesUnder(ctx, "g")).toEqual(["S"]);

    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    const wNode = winNodeOf(ctx, w) as TreeNode;
    expect(await tracker.moveNode(nodeOf(ctx, a)?.id ?? "", "g", 1)).toEqual([]);
    expect(store.getTree().get(wNode.id)).toMatchObject({ liveWindowId: w.id });
    // Reordering inside the same parent never triggers a prune check.
    expect(await tracker.moveNode("s", "g", 1)).toEqual([]);
  });

  it("close-and-save then delete: the saved window goes with its last saved tab", async () => {
    const ctx = await realistic();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    const b = fb.openTab(w.id, "https://b.test/", "B");
    const wNode = winNodeOf(ctx, w) as TreeNode;
    const aNode = nodeOf(ctx, a) as TreeNode;
    const bNode = nodeOf(ctx, b) as TreeNode;
    expect(await tracker.closeAndSave(wNode.id)).toBe(2);
    expect(store.getTree().get(wNode.id)?.liveWindowId).toBeUndefined();
    expect(titlesUnder(ctx, wNode.id)).toEqual(["A", "B"]);
    expect((await tracker.deleteNode(aNode.id)).map((n) => n.id)).toEqual([aNode.id]);
    expect(store.getTree().has(wNode.id)).toBe(true);
    expect((await tracker.deleteNode(bNode.id)).map((n) => n.id)).toEqual([wNode.id, bNode.id]);
    expect(store.getTree().size).toBe(0);
  });

  it("cascades through nested windows and stops at a group", async () => {
    const ctx = await realistic();
    const { store, tracker } = ctx;
    store.append([
      ops.add(makeNode({ id: "outer", parentId: null, kind: "window", title: "Outer", ts: 1 })),
      ops.add(makeNode({ id: "inner", parentId: "outer", kind: "window", title: "Inner", ts: 1 })),
    ]);
    addSavedTab(ctx, "s", "inner", "https://s.test/", "S");
    expect((await tracker.deleteNode("s")).map((n) => n.id)).toEqual(["outer", "inner", "s"]);
    expect(store.getTree().size).toBe(0);

    addRootGroup(ctx, "g");
    store.append([
      ops.add(makeNode({ id: "w", parentId: "g", kind: "window", title: "W", ts: 1 })),
    ]);
    addSavedTab(ctx, "t", "w", "https://t.test/", "T");
    expect((await tracker.deleteNode("t")).map((n) => n.id)).toEqual(["w", "t"]);
    expect([...store.getTree().keys()]).toEqual(["g"]);
  });

  it("deleting a live window node closes its tabs and leaves nothing behind", async () => {
    const ctx = await realistic();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    const b = fb.openTab(w.id, "https://b.test/", "B", { openerTabId: a.id });
    const wNode = winNodeOf(ctx, w) as TreeNode;
    const removed = await tracker.deleteNode(wNode.id);
    expect(removed.map((n) => n.title)).toEqual(["Window", "A", "B"]);
    expect(fb.removed.sort()).toEqual([a.id, b.id].sort());
    expect(store.getTree().size).toBe(0); // the tab events did not re-save anything
  });

  it("startup sweep removes childless window nodes left by older versions, logged as ops", async () => {
    // A tree persisted by an older version: an empty saved window, an empty window still
    // claiming a browser window id that no longer exists, and a saved window with content.
    const store = new MemoryTreeStore();
    await store.open();
    store.append([
      ops.add(makeNode({ id: "empty", parentId: null, kind: "window", title: "Window", ts: 1 })),
      ops.add(
        makeNode({
          id: "stale",
          parentId: null,
          kind: "window",
          title: "Window",
          liveWindowId: 99,
          ts: 1,
        }),
      ),
      ops.add(makeNode({ id: "kept", parentId: null, kind: "window", title: "Window", ts: 1 })),
      ops.add(
        makeNode({
          id: "s",
          parentId: "kept",
          kind: "tab",
          title: "S",
          url: "https://s.test/",
          ts: 1,
        }),
      ),
    ]);
    await store.compact(true);
    const fb = new FakeBrowser();
    fb.closeEmptyWindows = true;
    const w = fb.addWindow();
    fb.addTab(w.id, "https://a.test/", "A");
    const tracker = new TabTracker(store, fb, { newId, now: () => 1 });
    fb.tracker = tracker;
    const report = await tracker.rebuild();
    expect(report.windowsPruned).toBe(2);
    expect(report.windowsCreated).toBe(1);
    const tree = store.getTree();
    expect(tree.has("empty")).toBe(false);
    expect(tree.has("stale")).toBe(false);
    expect(tree.get("kept")).toBeDefined();
    expect(tree.get("kept")?.liveWindowId).toBeUndefined();
    // The live window created for the browser's open window is untouched.
    const live = [...tree.values()].filter((n) => n.kind === "window" && n.liveWindowId === w.id);
    expect(live.length).toBe(1);
    // Migration-safe: the removals are ordinary ops in the log, replayable and recoverable.
    await store.flush();
    const removes = [...store.memory.ops.values()]
      .map((raw) => raw as { type: string; id?: string })
      .filter((o) => o.type === "remove")
      .map((o) => o.id)
      .sort();
    expect(removes).toEqual(["empty", "stale"]);
    // Running the sweep again finds nothing more to do.
    expect((await tracker.rebuild()).windowsPruned).toBe(0);
  });

  it("startup sweep keeps a live window whose only tab node was moved into a group", async () => {
    const ctx = await realistic();
    const { store, fb } = ctx;
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    const wNode = winNodeOf(ctx, w) as TreeNode;
    addRootGroup(ctx, "g");
    await dropInside(ctx, nodeOf(ctx, a)?.id ?? "", "g");
    const { report } = await restartWorker(ctx);
    expect(report.windowsPruned).toBe(0);
    expect(store.getTree().get(wNode.id)).toMatchObject({ liveWindowId: w.id });
  });
});

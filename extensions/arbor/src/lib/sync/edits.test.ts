import { describe, expect, it } from "vitest";
import { childrenOf, makeNode, ops, rootsOf, type TreeNode } from "../model";
import {
  addGroup,
  addRootGroup,
  addSavedTab,
  idOf,
  nodeAt,
  nodeOf,
  setup,
  titlesUnder,
  winNodeOf,
} from "./testing/fake-browser";

/**
 * The two ways out of the tree. "Remove from tree" never reaches the browser: whatever mirrors an
 * open tab or window stays and is reset to a plain mirror. "Close tabs and remove" closes the
 * open tabs beneath the node first, then removes the subtree.
 */
describe("removeNode (remove from tree)", () => {
  async function realistic() {
    const ctx = await setup();
    ctx.fb.closeEmptyWindows = true;
    return ctx;
  }

  it("removes a group with saved tabs and notes; open tabs filed in it go back under their window in strip order", async () => {
    const ctx = await realistic();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    const b = fb.openTab(w.id, "https://b.test/", "B");
    const c = fb.openTab(w.id, "https://c.test/", "C");
    const d = fb.openTab(w.id, "https://d.test/", "D");
    const wNode = winNodeOf(ctx, w) as TreeNode;
    addRootGroup(ctx, "g");
    addSavedTab(ctx, "s", "g", "https://s.test/", "S");
    store.append([
      ops.add(makeNode({ id: "memo", parentId: "g", kind: "note", title: "memo", ts: 1 })),
    ]);
    // Filed out of strip order on purpose: D first, then B, both still open in W.
    await tracker.moveNode(idOf(ctx, d), "g", 0);
    await tracker.moveNode(idOf(ctx, b), "g", 2);
    expect(titlesUnder(ctx, "g")).toEqual(["D", "S", "B", "memo"]);
    expect(titlesUnder(ctx, wNode.id)).toEqual(["A", "C"]);

    const removed = tracker.removeNode("g");
    expect(removed.map((n) => n.title)).toEqual(["g", "S", "memo"]);
    expect(fb.removed).toEqual([]);
    expect(fb.moved).toEqual([]);
    expect(fb.stripOrder(w.id)).toEqual([a.id, b.id, c.id, d.id]);
    expect(titlesUnder(ctx, wNode.id)).toEqual(["A", "B", "C", "D"]);
    expect(childrenOf(store.getTree(), wNode.id).map((n) => n.liveTabId)).toEqual(
      fb.stripOrder(w.id),
    );
    expect(store.getTree().has("g")).toBe(false);
    expect(store.getTree().size).toBe(5); // W + four open tabs
  });

  it("keeps opener nesting among open tabs that move together, and notes on them are dropped", async () => {
    const ctx = await realistic();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    const b = fb.openTab(w.id, "https://b.test/", "B");
    const c = fb.openTab(w.id, "https://c.test/", "C", { openerTabId: b.id }); // nested under B
    const wNode = winNodeOf(ctx, w) as TreeNode;
    addRootGroup(ctx, "g");
    await tracker.moveNode(idOf(ctx, b), "g", 0); // B (with C beneath) filed in the group
    store.append([
      ops.update(idOf(ctx, b), { note: "n1" }),
      ops.update(idOf(ctx, c), { note: "n2" }),
    ]);
    expect(titlesUnder(ctx, wNode.id)).toEqual(["A"]);

    tracker.removeNode("g");
    expect(titlesUnder(ctx, wNode.id)).toEqual(["A", "B"]);
    expect(titlesUnder(ctx, idOf(ctx, b))).toEqual(["C"]); // C stays under B, which came home
    expect(nodeOf(ctx, b)?.note).toBeUndefined();
    expect(nodeOf(ctx, c)?.note).toBeUndefined();
  });

  it("on an open window: the container stays bound, loses its title and note, saved items go, open tabs keep their place", async () => {
    const ctx = await realistic();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    fb.openTab(w.id, "https://b.test/", "B", { openerTabId: a.id });
    const wNode = winNodeOf(ctx, w) as TreeNode;
    addSavedTab(ctx, "s", wNode.id, "https://s.test/", "S");
    addGroup(ctx, "inner", wNode.id); // a closed group nested in the window
    addSavedTab(ctx, "t", "inner", "https://t.test/", "T");
    store.append([ops.update(wNode.id, { title: "Work", note: "n" })]);

    const removed = tracker.removeNode(wNode.id);
    expect(removed.map((n) => n.id)).toEqual(["s", "inner", "t"]);
    expect(fb.removed).toEqual([]);
    expect(nodeAt(ctx, wNode.id)).toMatchObject({ title: "", liveWindowId: w.id });
    expect(nodeAt(ctx, wNode.id).note).toBeUndefined();
    expect(titlesUnder(ctx, wNode.id)).toEqual(["A"]);
    expect(titlesUnder(ctx, idOf(ctx, a))).toEqual(["B"]);
  });

  it("an open tab from another window filed under this one goes back to its own window", async () => {
    const ctx = await realistic();
    const { store, fb, tracker } = ctx;
    const w1 = fb.openWindow();
    fb.openTab(w1.id, "https://a.test/", "A");
    const w2 = fb.openWindow();
    fb.openTab(w2.id, "https://x.test/", "X");
    const y = fb.openTab(w2.id, "https://y.test/", "Y");
    fb.openTab(w2.id, "https://z.test/", "Z");
    const w1Node = winNodeOf(ctx, w1) as TreeNode;
    const w2Node = winNodeOf(ctx, w2) as TreeNode;
    // Y's node filed under window 1 by a tree-only edit (an undo step, say); the tab stays in 2.
    store.append([ops.move(idOf(ctx, y), w1Node.id, 0)]);
    expect(titlesUnder(ctx, w2Node.id)).toEqual(["X", "Z"]);

    const removed = tracker.removeNode(w1Node.id);
    expect(removed).toEqual([]); // nothing to delete: only a tab to send home
    expect(titlesUnder(ctx, w1Node.id)).toEqual(["A"]);
    expect(titlesUnder(ctx, w2Node.id)).toEqual(["X", "Y", "Z"]);
    expect(fb.removed).toEqual([]);
    expect(fb.moved).toEqual([]);
  });

  it("an open window nested in a removed group moves to the root; its own saved items go with the group", async () => {
    const ctx = await realistic();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    const wNode = winNodeOf(ctx, w) as TreeNode;
    addRootGroup(ctx, "g");
    addSavedTab(ctx, "s", "g", "https://s.test/", "S");
    await tracker.moveNode(wNode.id, "g", 1); // the open window filed inside the group
    addSavedTab(ctx, "t", wNode.id, "https://t.test/", "T");
    store.append([ops.update(wNode.id, { title: "Nested" })]);
    expect(rootsOf(store.getTree()).map((n) => n.id)).toEqual(["g"]);

    const removed = tracker.removeNode("g");
    expect(removed.map((n) => n.id)).toEqual(["g", "s", "t"]);
    expect(rootsOf(store.getTree()).map((n) => n.id)).toEqual([wNode.id]);
    expect(nodeAt(ctx, wNode.id)).toMatchObject({ title: "", liveWindowId: w.id });
    expect(titlesUnder(ctx, wNode.id)).toEqual(["A"]);
    expect(fb.removed).toEqual([]);
    expect(fb.windows.length).toBe(1);
  });

  it("a note with an open tab beneath it: the note goes, the tab comes home", async () => {
    const ctx = await realistic();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    const b = fb.openTab(w.id, "https://b.test/", "B");
    const wNode = winNodeOf(ctx, w) as TreeNode;
    store.append([
      ops.add(makeNode({ id: "memo", parentId: wNode.id, kind: "note", title: "memo", ts: 1 }), 0),
    ]);
    await tracker.moveNode(idOf(ctx, b), "memo", 0);
    expect(titlesUnder(ctx, wNode.id)).toEqual(["memo", "A"]);

    expect(tracker.removeNode("memo").map((n) => n.id)).toEqual(["memo"]);
    expect(titlesUnder(ctx, wNode.id)).toEqual(["A", "B"]);
    expect(fb.removed).toEqual([]);
  });

  it("a saved tab in a closed untitled window: the window is pruned with it, both reported outermost first", async () => {
    const ctx = await realistic();
    const { store, tracker } = ctx;
    store.append([
      ops.add(makeNode({ id: "sw", parentId: null, kind: "window", title: "", ts: 1 })),
    ]);
    addSavedTab(ctx, "s", "sw", "https://s.test/", "S");
    expect(tracker.removeNode("s").map((n) => n.id)).toEqual(["sw", "s"]);
    expect(store.getTree().size).toBe(0);
  });

  it("a node that claims a tab the browser no longer has is closed for every practical purpose: it goes", async () => {
    const ctx = await realistic();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    addRootGroup(ctx, "g");
    store.append([
      ops.add(
        makeNode({
          id: "stale",
          parentId: "g",
          kind: "tab",
          title: "Stale",
          url: "https://stale.test/",
          liveTabId: 999,
          liveWindowId: w.id,
          ts: 1,
        }),
      ),
    ]);
    expect(tracker.removeNode("g").map((n) => n.id)).toEqual(["g", "stale"]);
    expect(fb.removed).toEqual([]);
  });

  it("does nothing for a bare open tab already under its window, or an unknown node", async () => {
    const ctx = await realistic();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    const before = store.getTree();
    expect(tracker.removeNode(idOf(ctx, a))).toEqual([]);
    expect(store.getTree()).toBe(before); // not a single op appended
    expect(tracker.removeNode("ghost")).toEqual([]);
  });
});

describe("closeAndRemove (close tabs and remove)", () => {
  it("closes exactly the open tabs beneath the node and removes the subtree, nothing saved", async () => {
    const ctx = await setup();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    const b = fb.openTab(w.id, "https://b.test/", "B");
    const c = fb.openTab(w.id, "https://c.test/", "C");
    const wNode = winNodeOf(ctx, w) as TreeNode;
    addRootGroup(ctx, "g");
    await tracker.moveNode(idOf(ctx, b), "g", 0);
    addSavedTab(ctx, "s", "g", "https://s.test/", "S");
    addSavedTab(ctx, "s2", idOf(ctx, b), "https://s2.test/", "S2");

    const removed = await tracker.closeAndRemove("g");
    expect(removed.map((n) => n.title)).toEqual(["g", "B", "S2", "S"]);
    expect(fb.removed).toEqual([b.id]); // A and C were never part of the group
    expect(fb.stripOrder(w.id)).toEqual([a.id, c.id]);
    expect(store.getTree().has("g")).toBe(false);
    expect(childrenOf(store.getTree(), wNode.id).map((n) => n.title)).toEqual(["A", "C"]);
    expect(store.getTree().size).toBe(3);
  });

  it("on an open window closes every tab in it; the container goes with them", async () => {
    const ctx = await setup();
    ctx.fb.closeEmptyWindows = true;
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    const b = fb.openTab(w.id, "https://b.test/", "B");
    const wNode = winNodeOf(ctx, w) as TreeNode;
    const ids = [wNode.id, idOf(ctx, a), idOf(ctx, b)];
    const removed = await tracker.closeAndRemove(wNode.id);
    expect(removed.map((n) => n.id)).toEqual(ids);
    expect(fb.removed.sort()).toEqual([a.id, b.id].sort());
    expect(fb.windows).toEqual([]);
    expect(store.getTree().size).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { createHistory, HistoryStack, type HistoryEntry } from "./index";
import { childrenOf, makeNode, ops, serializeNodes, type Tree, type TreeNode } from "../model";
import {
  addRootGroup,
  addSavedTab,
  nodeOf,
  setup,
  titlesUnder,
  winNodeOf,
  type Ctx,
} from "../sync/testing/fake-browser";

const history = createHistory(() => 1);

/**
 * The side panel's half of undo, against a fake browser: build the entry from the tree as shown
 * before the action plus the background's response, then run its steps through the tracker the
 * way the `applyHistoryStep` handler does.
 */
async function run(ctx: Ctx, steps: HistoryEntry["undo"]): Promise<void> {
  for (const step of steps) await ctx.tracker.runHistoryStep(step);
}

/** id, parent, sibling order and live-ness of every node, depth-first. */
const shape = (tree: Tree) =>
  serializeNodes(tree).map((n) => [n.id, n.parentId, n.order, n.liveTabId !== undefined]);

async function realistic() {
  const ctx = await setup();
  ctx.fb.closeEmptyWindows = true;
  return ctx;
}

describe("undo / redo flows", () => {
  it("delete subtree -> undo: nodes come back in place with the same ids, saved; redo deletes again", async () => {
    const ctx = await realistic();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    const d = fb.openTab(w.id, "https://d.test/", "D");
    const b = fb.openTab(w.id, "https://b.test/", "B");
    const c = fb.openTab(w.id, "https://c.test/", "C", { openerTabId: b.id });
    const bNode = nodeOf(ctx, b) as TreeNode;
    const cNode = nodeOf(ctx, c) as TreeNode;
    store.append([ops.update(bNode.id, { note: "important" })]);
    const wNode = winNodeOf(ctx, w) as TreeNode;
    expect(titlesUnder(ctx, wNode.id)).toEqual(["A", "D", "B"]);
    expect(titlesUnder(ctx, bNode.id)).toEqual(["C"]);
    const before = store.getTree();

    const removed = await tracker.deleteNode(bNode.id);
    expect(removed.map((n) => n.id)).toEqual([bNode.id, cNode.id]);
    expect(fb.removed.sort()).toEqual([b.id, c.id].sort());
    expect(titlesUnder(ctx, wNode.id)).toEqual(["A", "D"]);
    const entry = history.remove(before, removed, bNode.id) as HistoryEntry;
    expect(entry.label).toBe("delete 2 tabs");

    await run(ctx, entry.undo);
    const tree = store.getTree();
    expect(titlesUnder(ctx, wNode.id)).toEqual(["A", "D", "B"]);
    expect(tree.get(bNode.id)).toMatchObject({
      id: bNode.id,
      parentId: wNode.id,
      note: "important",
    });
    expect(tree.get(cNode.id)).toMatchObject({ id: cNode.id, parentId: bNode.id });
    expect(childrenOf(tree, wNode.id).map((n) => n.id)).toEqual([
      nodeOf(ctx, a)?.id,
      nodeOf(ctx, d)?.id,
      bNode.id,
    ]);
    // Their tabs were closed without saving, so they are back as saved nodes.
    expect(tree.get(bNode.id)?.liveTabId).toBeUndefined();
    expect(tree.get(cNode.id)?.liveTabId).toBeUndefined();
    expect(shape(tree)).toEqual(
      shape(before).map(([id, p, o, live]) => [
        id,
        p,
        o,
        id === bNode.id || id === cNode.id ? false : live,
      ]),
    );

    await run(ctx, entry.redo);
    expect(store.getTree().has(bNode.id)).toBe(false);
    expect(store.getTree().has(cNode.id)).toBe(false);
    expect(titlesUnder(ctx, wNode.id)).toEqual(["A", "D"]);
  });

  it("delete the last tab of a window (window pruned) -> undo: window and tab return at their old place", async () => {
    const ctx = await realistic();
    const { store, fb, tracker } = ctx;
    addRootGroup(ctx, "g0");
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    addRootGroup(ctx, "g2");
    const wNode = winNodeOf(ctx, w) as TreeNode;
    const aNode = nodeOf(ctx, a) as TreeNode;
    expect(childrenOf(store.getTree(), null).map((n) => n.id)).toEqual(["g0", wNode.id, "g2"]);
    const before = store.getTree();

    const removed = await tracker.deleteNode(aNode.id);
    expect(removed.map((n) => n.id)).toEqual([wNode.id, aNode.id]);
    expect([...store.getTree().keys()]).toEqual(["g0", "g2"]);
    const entry = history.remove(before, removed, aNode.id) as HistoryEntry;

    await run(ctx, entry.undo);
    const tree = store.getTree();
    expect(childrenOf(tree, null).map((n) => n.id)).toEqual(["g0", wNode.id, "g2"]);
    expect(tree.get(wNode.id)).toMatchObject({ kind: "window", parentId: null });
    expect(tree.get(wNode.id)?.liveWindowId).toBeUndefined(); // the browser window is gone
    expect(tree.get(aNode.id)).toMatchObject({ parentId: wNode.id, title: "A" });
    expect(tree.get(aNode.id)?.liveTabId).toBeUndefined();
    // The restored closed container can be reopened like any other: as a browser window.
    await tracker.restore(wNode.id);
    expect(store.getTree().get(wNode.id)?.liveWindowId).toBe(fb.windows[0]?.id);
    expect(store.getTree().get(aNode.id)?.liveTabId).toBeDefined();
  });

  it("move -> undo: original position; redo: moved again", async () => {
    const ctx = await realistic();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    const b = fb.openTab(w.id, "https://b.test/", "B");
    fb.openTab(w.id, "https://c.test/", "C");
    addRootGroup(ctx, "g");
    const bNode = nodeOf(ctx, b) as TreeNode;
    const wNode = winNodeOf(ctx, w) as TreeNode;
    const before = store.getTree();

    const pruned = await tracker.moveNode(bNode.id, "g", 0);
    expect(pruned).toEqual([]);
    expect(titlesUnder(ctx, wNode.id)).toEqual(["A", "C"]);
    expect(titlesUnder(ctx, "g")).toEqual(["B"]);
    const entry = history.move(
      before,
      { id: bNode.id, parentId: "g", index: 0 },
      pruned,
    ) as HistoryEntry;
    expect(entry.label).toBe('move "B"');

    await run(ctx, entry.undo);
    expect(titlesUnder(ctx, wNode.id)).toEqual(["A", "B", "C"]);
    expect(titlesUnder(ctx, "g")).toEqual([]);
    expect(shape(store.getTree())).toEqual(shape(before));
    expect(fb.moved).toEqual([]); // the browser tab never left its strip position

    await run(ctx, entry.redo);
    expect(titlesUnder(ctx, wNode.id)).toEqual(["A", "C"]);
    expect(titlesUnder(ctx, "g")).toEqual(["B"]);
  });

  it("move out of a closed untitled window (pruned) -> undo: the window is back and the tab inside it", async () => {
    const ctx = await realistic();
    const { store, tracker } = ctx;
    addRootGroup(ctx, "g");
    store.append([
      ops.add(makeNode({ id: "sw", parentId: null, kind: "window", title: "", ts: 1 })),
    ]);
    addSavedTab(ctx, "s", "sw", "https://s.test/", "S");
    const before = store.getTree();
    const pruned = await tracker.moveNode("s", "g", 0);
    expect(pruned.map((n) => n.id)).toEqual(["sw"]);
    expect(store.getTree().has("sw")).toBe(false);
    const entry = history.move(
      before,
      { id: "s", parentId: "g", index: 0 },
      pruned,
    ) as HistoryEntry;
    await run(ctx, entry.undo);
    expect(shape(store.getTree())).toEqual(shape(before));
    expect(titlesUnder(ctx, "sw")).toEqual(["S"]);
    await run(ctx, entry.redo);
    expect(store.getTree().has("sw")).toBe(false);
    expect(titlesUnder(ctx, "g")).toEqual(["S"]);
  });

  it("close-and-save a tab -> undo: reopened in place at its strip position", async () => {
    const ctx = await realistic();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    const b = fb.openTab(w.id, "https://b.test/", "B");
    const c = fb.openTab(w.id, "https://c.test/", "C");
    const bNode = nodeOf(ctx, b) as TreeNode;
    const wNode = winNodeOf(ctx, w) as TreeNode;
    const before = store.getTree();

    const entry = history.closeAndSave(before, bNode.id) as HistoryEntry;
    expect(await tracker.closeAndSave(bNode.id)).toBe(1);
    expect(store.getTree().get(bNode.id)?.liveTabId).toBeUndefined();
    expect(fb.stripOrder(w.id)).toEqual([a.id, c.id]);
    expect(entry.label).toBe('close "B"');

    await run(ctx, entry.undo);
    const restored = store.getTree().get(bNode.id) as TreeNode;
    expect(restored).toMatchObject({ parentId: wNode.id, liveWindowId: w.id });
    expect(restored.liveTabId).toBeDefined();
    expect(fb.stripOrder(w.id)).toEqual([a.id, restored.liveTabId, c.id]);
    expect(titlesUnder(ctx, wNode.id)).toEqual(["A", "B", "C"]);
    expect(store.getTree().size).toBe(before.size);

    await run(ctx, entry.redo);
    expect(store.getTree().get(bNode.id)?.liveTabId).toBeUndefined();
    expect(fb.stripOrder(w.id)).toEqual([a.id, c.id]);
    expect(titlesUnder(ctx, wNode.id)).toEqual(["A", "B", "C"]);
  });

  it("close-and-save a whole window -> undo: reopened as one window onto the same nodes", async () => {
    const ctx = await realistic();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    fb.openTab(w.id, "https://b.test/", "B");
    const wNode = winNodeOf(ctx, w) as TreeNode;
    const ids = childrenOf(store.getTree(), wNode.id).map((n) => n.id);
    const before = store.getTree();

    const entry = history.closeAndSave(before, wNode.id) as HistoryEntry;
    expect(entry.label).toBe("close 2 tabs");
    expect(await tracker.closeAndSave(wNode.id)).toBe(2);
    expect(fb.windows).toEqual([]);
    expect(store.getTree().get(wNode.id)?.liveWindowId).toBeUndefined();

    await run(ctx, entry.undo);
    const tree = store.getTree();
    expect(tree.size).toBe(before.size);
    expect(fb.windows.length).toBe(1);
    expect(tree.get(wNode.id)?.liveWindowId).toBe(fb.windows[0]?.id);
    expect(childrenOf(tree, wNode.id).map((n) => n.id)).toEqual(ids);
    expect(childrenOf(tree, wNode.id).map((n) => n.liveTabId)).toEqual(
      fb.stripOrder(fb.windows[0]?.id ?? -1),
    );

    await run(ctx, entry.redo);
    expect(fb.windows).toEqual([]);
    expect(store.getTree().size).toBe(before.size);
    expect(childrenOf(store.getTree(), wNode.id).every((n) => n.liveTabId === undefined)).toBe(
      true,
    );
  });

  it("reopen a group -> it opens as a window; undo closes that window, nodes saved in place; redo reopens it", async () => {
    const ctx = await realistic();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    addRootGroup(ctx, "g");
    addSavedTab(ctx, "s", "g", "https://s.test/", "S");
    addSavedTab(ctx, "c", "s", "https://c.test/", "C");
    addSavedTab(ctx, "t", "g", "https://t.test/", "T");
    const before = store.getTree();

    const entry = history.reopen(before, "g") as HistoryEntry;
    expect(entry.label).toBe("reopen 3 tabs");
    expect(await tracker.reopenAll("g")).toBe(3);
    // One new browser window, bound to the group, holding S, C, T in tree order.
    expect(fb.windows.length).toBe(2);
    const gWin = store.getTree().get("g")?.liveWindowId;
    expect(gWin).toBe(fb.windows[1]?.id);
    const liveIds = ["s", "c", "t"].map((id) => store.getTree().get(id)?.liveTabId);
    expect(liveIds.every((id) => id !== undefined)).toBe(true);
    expect(fb.stripOrder(gWin ?? -1)).toEqual(liveIds);
    expect(fb.stripOrder(w.id).length).toBe(1); // the other window is untouched

    await run(ctx, entry.undo);
    // The tabs closed, the window went with them; the group stays, unbound, with its nodes.
    expect(fb.windows.map((x) => x.id)).toEqual([w.id]);
    expect(store.getTree().get("g")?.liveWindowId).toBeUndefined();
    for (const id of ["s", "c", "t"]) expect(store.getTree().get(id)?.liveTabId).toBeUndefined();
    expect(shape(store.getTree())).toEqual(shape(before));
    expect(titlesUnder(ctx, winNodeOf(ctx, w)?.id)).toEqual(["A"]);

    await run(ctx, entry.redo);
    expect(fb.windows.length).toBe(2);
    expect(store.getTree().get("g")?.liveWindowId).toBe(fb.windows[1]?.id);
    for (const id of ["s", "c", "t"]) expect(store.getTree().get(id)?.liveTabId).toBeDefined();
    expect(titlesUnder(ctx, "g")).toEqual(["S", "T"]);
    expect(titlesUnder(ctx, "s")).toEqual(["C"]);
  });

  it("close a window -> undo brings it back as one window; close a single tab of a group -> undo reopens it where it was", async () => {
    const ctx = await realistic();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    const a = fb.openTab(w.id, "https://a.test/", "A");
    const b = fb.openTab(w.id, "https://b.test/", "B");
    addRootGroup(ctx, "g");
    const bNode = nodeOf(ctx, b) as TreeNode;
    await tracker.moveNode(bNode.id, "g", 0); // B open in W, filed under the group
    const before = store.getTree();

    // Close & save on the group only closes B; the undo reopens B in the focused window, still
    // filed under the group, exactly as it was (no new window for a group whose tab merely sat
    // elsewhere).
    const closeB = history.closeAndSave(before, "g") as HistoryEntry;
    expect(closeB.undo).toEqual([{ kind: "reopen", ids: [bNode.id] }]);
    expect(await tracker.closeAndSave("g")).toBe(1);
    await run(ctx, closeB.undo);
    expect(fb.windows.map((x) => x.id)).toEqual([w.id]);
    expect(store.getTree().get(bNode.id)).toMatchObject({ parentId: "g", liveWindowId: w.id });
    expect(fb.stripOrder(w.id).length).toBe(2);
    expect(store.getTree().get("g")?.liveWindowId).toBeUndefined();
    void a;
  });

  it("new group / rename / note -> undo and redo; an emptied-then-filled group is not removed", async () => {
    const ctx = await realistic();
    const { store, tracker } = ctx;
    const grp = makeNode({ id: "g", parentId: null, kind: "window", title: "New group", ts: 1 });
    store.append([ops.add(grp, 0)]);
    const created = history.create(store.getTree().get("g") as TreeNode, 0);
    const renamed = history.rename(store.getTree(), "g", "Research") as HistoryEntry;
    await run(ctx, renamed.redo);
    const noted = history.note(store.getTree(), "g", "read later") as HistoryEntry;
    await run(ctx, noted.redo);
    expect(store.getTree().get("g")).toMatchObject({ title: "Research", note: "read later" });

    await run(ctx, noted.undo);
    expect(store.getTree().get("g")?.note).toBeUndefined();
    await run(ctx, renamed.undo);
    expect(store.getTree().get("g")?.title).toBe("New group");
    await run(ctx, created.undo);
    expect(store.getTree().has("g")).toBe(false);
    await run(ctx, created.redo);
    expect(store.getTree().get("g")).toMatchObject({ id: "g", title: "New group" });

    // Something landed in the group meanwhile: undoing its creation must not take that with it.
    addSavedTab(ctx, "s", "g", "https://s.test/", "S");
    await expect(run(ctx, created.undo)).rejects.toThrow(/no longer empty/);
    expect(store.getTree().has("g")).toBe(true);
    expect(store.getTree().has("s")).toBe(true);
    // Steps on vanished nodes fail loudly instead of guessing.
    await tracker.deleteNode("s");
    await expect(run(ctx, [{ kind: "move", id: "s", parentId: null, index: 0 }])).rejects.toThrow(
      /no longer exists/,
    );
  });

  it("a panel session: several actions, undo them all, redo them all", async () => {
    const ctx = await realistic();
    const { store, fb, tracker } = ctx;
    const w = fb.openWindow();
    fb.openTab(w.id, "https://a.test/", "A");
    const b = fb.openTab(w.id, "https://b.test/", "B");
    fb.openTab(w.id, "https://c.test/", "C");
    const wNode = winNodeOf(ctx, w) as TreeNode;
    const bNode = nodeOf(ctx, b) as TreeNode;
    addRootGroup(ctx, "g");
    const start = store.getTree();
    const stack = new HistoryStack();

    // 1. drag B into the group, 2. close & save the group, 3. rename the group, 4. delete A.
    let before = store.getTree();
    stack.push(
      history.move(
        before,
        { id: bNode.id, parentId: "g", index: 0 },
        await tracker.moveNode(bNode.id, "g", 0),
      ) as HistoryEntry,
    );
    before = store.getTree();
    const close = history.closeAndSave(before, "g") as HistoryEntry;
    await tracker.closeAndSave("g");
    stack.push(close);
    before = store.getTree();
    stack.push(history.rename(before, "g", "Later") as HistoryEntry);
    await run(ctx, stack.peekUndo()?.redo ?? []);
    before = store.getTree();
    const aNode = childrenOf(before, wNode.id)[0] as TreeNode;
    stack.push(
      history.remove(before, await tracker.deleteNode(aNode.id), aNode.id) as HistoryEntry,
    );
    const end = store.getTree();
    expect(titlesUnder(ctx, wNode.id)).toEqual(["C"]);
    expect(end.get("g")).toMatchObject({ title: "Later" });
    expect(end.get(bNode.id)?.liveTabId).toBeUndefined();

    const labels: string[] = [];
    while (stack.canUndo) {
      const e = stack.takeUndo() as HistoryEntry;
      labels.push(e.label);
      await run(ctx, e.undo);
      stack.undone(e);
    }
    expect(labels).toEqual(['delete "A"', 'rename "g"', "close 1 tab", 'move "B"']);
    const undone = store.getTree();
    expect(titlesUnder(ctx, wNode.id)).toEqual(["A", "B", "C"]);
    expect(titlesUnder(ctx, "g")).toEqual([]);
    expect(undone.get("g")?.title).toBe("g");
    // Every node back with its id and place; A came back saved (its tab was deleted), B live.
    expect(shape(undone)).toEqual(
      shape(start).map(([id, p, o, live]) => [id, p, o, id === aNode.id ? false : live]),
    );

    while (stack.canRedo) {
      const e = stack.takeRedo() as HistoryEntry;
      await run(ctx, e.redo);
      stack.redone(e);
    }
    expect(shape(store.getTree())).toEqual(shape(end));
    expect(store.getTree().get("g")?.title).toBe("Later");
  });
});

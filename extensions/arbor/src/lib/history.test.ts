import { describe, expect, it } from "vitest";
import {
  asSaved,
  HISTORY_DEPTH,
  history,
  HistoryStack,
  inverseOps,
  readdOps,
  type HistoryEntry,
} from "./history";
import {
  applyOps,
  childrenOf,
  createTree,
  makeNode,
  ops,
  serializeNodes,
  type NodeId,
  type Tree,
  type TreeNode,
} from "./model";

function node(
  id: NodeId,
  parentId: NodeId | null,
  kind: TreeNode["kind"],
  extra: Partial<TreeNode> = {},
): TreeNode {
  return { ...makeNode({ id, parentId, kind, title: id.toUpperCase(), ts: 1 }), ...extra };
}
const tab = (id: NodeId, parentId: NodeId | null, live?: number) =>
  node(id, parentId, "tab", {
    url: `https://${id}.test/`,
    ...(live !== undefined ? { liveTabId: live, liveWindowId: 1 } : {}),
  });

/** Structure that must survive an undo: id, parent, sibling order and user-visible fields. */
const shape = (tree: Tree) =>
  serializeNodes(tree).map((n) => [n.id, n.parentId, n.order, n.title, n.note ?? null]);

/** Open window W with A, B, C; root group G (an unbound container) with saved S (child C2), T. */
function fixture(): Tree {
  return applyOps(createTree(), [
    ops.add(node("w", null, "window", { liveWindowId: 1 })),
    ops.add(tab("a", "w", 10)),
    ops.add(tab("b", "w", 11)),
    ops.add(tab("c", "w", 12)),
    ops.add(node("g", null, "window", { note: "keep" })),
    ops.add(tab("s", "g")),
    ops.add(tab("c2", "s")),
    ops.add(tab("t", "g")),
  ]);
}

describe("inverseOps", () => {
  it("inverts add, update, move and remove and restores the exact shape", () => {
    const before = fixture();
    const applied = [
      ops.add(node("new", "g", "note"), 1),
      ops.update("g", { title: "Renamed", note: null }),
      ops.move("b", "g", 0),
      ops.remove("s"),
    ];
    const after = applyOps(before, applied);
    expect(after.has("s")).toBe(false);
    const inverse = inverseOps(before, applied);
    // Inverses run in reverse order of the actions they undo.
    expect(inverse.map((o) => o.type)).toEqual(["add", "add", "move", "update", "remove"]);
    const restored = applyOps(after, inverse);
    expect(shape(restored)).toEqual(shape(before));
  });

  it("update inverse restores old values and clears fields that did not exist", () => {
    const before = fixture();
    const [inv] = inverseOps(before, [ops.update("a", { title: "x", note: "added" })]);
    expect(inv).toEqual({ type: "update", id: "a", patch: { title: "A", note: null } });
  });

  it("move inverse targets the original parent and sibling index", () => {
    const before = fixture();
    expect(inverseOps(before, [ops.move("b", null, 0)])).toEqual([ops.move("b", "w", 1)]);
    expect(inverseOps(before, [ops.move("c", "w", 0)])).toEqual([ops.move("c", "w", 2)]);
  });

  it("remove inverse re-adds the subtree at its old index, parents first and saved", () => {
    const before = fixture();
    const inverse = inverseOps(before, [ops.remove("a")]);
    expect(inverse).toEqual([ops.add(asSaved(before.get("a") as TreeNode), 0)]);
    const deep = inverseOps(before, [ops.remove("s")]);
    expect(deep.map((o) => (o.type === "add" ? [o.node.id, o.index] : o.type))).toEqual([
      ["s", 0],
      ["c2", undefined],
    ]);
    const restored = applyOps(applyOps(before, [ops.remove("s")]), deep);
    expect(childrenOf(restored, "g").map((n) => n.id)).toEqual(["s", "t"]);
    expect(childrenOf(restored, "s").map((n) => n.id)).toEqual(["c2"]);
  });

  it("skips ops that reference unknown nodes instead of throwing", () => {
    expect(
      inverseOps(fixture(), [ops.remove("ghost"), ops.update("ghost", { title: "x" })]),
    ).toEqual([]);
  });
});

describe("readdOps", () => {
  it("re-adds a pruned window before its tab, at their old positions, with live ids stripped", () => {
    const before = applyOps(createTree(), [
      ops.add(node("g", null, "window")),
      ops.add(node("w", null, "window", { liveWindowId: 5 })),
      ops.add(tab("a", "w", 50)),
    ]);
    // What deleteNode returns: window first, then the deleted subtree.
    const removed = [before.get("w") as TreeNode, before.get("a") as TreeNode];
    const adds = readdOps(before, removed);
    expect(adds).toEqual([
      ops.add(asSaved(before.get("w") as TreeNode), 1),
      ops.add(asSaved(before.get("a") as TreeNode)),
    ]);
    const restored = applyOps(applyOps(before, [ops.remove("a"), ops.remove("w")]), adds);
    expect(shape(restored)).toEqual(shape(before));
    expect(restored.get("w")?.liveWindowId).toBeUndefined();
    expect(restored.get("a")?.liveTabId).toBeUndefined();
  });

  it("falls back to the stored order when the panel's tree does not know the node", () => {
    const n = { ...tab("x", null), order: 3 };
    expect(readdOps(createTree(), [n])).toEqual([ops.add(n, 3)]);
  });
});

describe("entry builders", () => {
  it("rename: inverse restores the old title, nothing recorded for a no-op", () => {
    const before = fixture();
    expect(history.rename(before, "g", "G")).toBeNull();
    expect(history.rename(before, "ghost", "x")).toBeNull();
    const e = history.rename(before, "g", "Research", 7) as HistoryEntry;
    expect(e).toMatchObject({ label: 'rename "G"', done: 'Renamed "G"', ts: 7 });
    expect(e.undo).toEqual([{ kind: "ops", ops: [ops.update("g", { title: "G" })] }]);
    expect(e.redo).toEqual([{ kind: "ops", ops: [ops.update("g", { title: "Research" })] }]);
  });

  it("note: inverse restores or clears the note; whitespace-only changes are ignored", () => {
    const before = fixture();
    expect(history.note(before, "g", " keep ")).toBeNull();
    const set = history.note(before, "a", "todo") as HistoryEntry;
    expect(set.undo).toEqual([{ kind: "ops", ops: [ops.update("a", { note: null })] }]);
    expect(set.redo).toEqual([{ kind: "ops", ops: [ops.update("a", { note: "todo" })] }]);
    const clear = history.note(before, "g", "") as HistoryEntry;
    expect(clear.undo).toEqual([{ kind: "ops", ops: [ops.update("g", { note: "keep" })] }]);
    expect(clear.redo).toEqual([{ kind: "ops", ops: [ops.update("g", { note: null })] }]);
  });

  it("create: undo removes the new group only while empty, redo adds it back in place", () => {
    const grp = node("g2", null, "window"); // a group is an unbound container
    const e = history.create(grp, 0);
    expect(e.label).toBe("new group");
    expect(history.create(node("n", null, "note"), 0).label).toBe("new note");
    expect(e.undo).toEqual([{ kind: "removeEmpty", id: "g2" }]);
    expect(e.redo).toEqual([{ kind: "ops", ops: [ops.add(grp, 0)] }]);
  });

  it("move: undo moves back to the original parent and index, re-adding pruned windows first", () => {
    const before = fixture();
    const e = history.move(before, "c", "g", 0) as HistoryEntry;
    expect(e.label).toBe('move "C"');
    expect(e.undo).toEqual([{ kind: "move", id: "c", parentId: "w", index: 2 }]);
    expect(e.redo).toEqual([{ kind: "move", id: "c", parentId: "g", index: 0 }]);
    // Moving the last tab out of a saved window pruned it: undo restores the window first.
    const saved = applyOps(createTree(), [
      ops.add(node("g", null, "window")),
      ops.add(node("sw", null, "window", { title: "" })),
      ops.add(tab("x", "sw")),
    ]);
    const pruned = [saved.get("sw") as TreeNode];
    const e2 = history.move(saved, "x", "g", 0, pruned) as HistoryEntry;
    expect(e2.undo).toEqual([
      { kind: "ops", ops: [ops.add(saved.get("sw") as TreeNode, 1)] },
      { kind: "move", id: "x", parentId: "sw", index: 0 },
    ]);
    expect(history.move(before, "ghost", null, 0)).toBeNull();
  });

  it("remove: labels describe what went, undo re-adds everything, redo deletes again", () => {
    const before = fixture();
    const a = before.get("a") as TreeNode;
    const one = history.remove(before, [a], "a") as HistoryEntry;
    expect(one.label).toBe('delete "A"');
    expect(one.done).toBe('Deleted "A"');
    expect(one.undo).toEqual([{ kind: "ops", ops: [ops.add(asSaved(a), 0)] }]);
    expect(one.redo).toEqual([{ kind: "delete", id: "a" }]);

    const g = ["g", "s", "c2", "t"].map((id) => before.get(id) as TreeNode);
    expect(history.remove(before, g, "g")?.label).toBe('delete "G" (3 tabs)');
    const w = ["w", "a", "b", "c"].map((id) => before.get(id) as TreeNode);
    expect(history.remove(before, w, "w")?.label).toBe('delete "W" (3 tabs)');
    const s = ["s", "c2"].map((id) => before.get(id) as TreeNode);
    expect(history.remove(before, s, "s")?.label).toBe("delete 2 tabs");
    expect(history.remove(before, [node("n", "g", "note")], "n")?.label).toBe("delete note");
    expect(history.remove(before, [], "a")).toBeNull();
    // A browser-made window has no title of its own; labels say "Window".
    const auto = applyOps(before, [ops.update("w", { title: "" })]);
    const w2 = ["w", "a", "b", "c"].map((id) => auto.get(id) as TreeNode);
    expect(history.remove(auto, w2, "w")?.label).toBe('delete "Window" (3 tabs)');
    expect(history.rename(auto, "w", "Work")?.label).toBe('rename "Window"');
  });

  it("closeAndSave: undo reopens exactly the tabs that were open, redo closes them again", () => {
    const before = fixture();
    const e = history.closeAndSave(before, "w") as HistoryEntry;
    expect(e.label).toBe("close 3 tabs");
    expect(e.done).toBe("Closed and saved 3 tabs");
    // Closing an open window as a whole: the undo brings that window back as one.
    expect(e.undo).toEqual([{ kind: "reopen", ids: ["a", "b", "c"], container: "w" }]);
    expect(e.redo).toEqual([{ kind: "close", ids: ["a", "b", "c"] }]);
    // A single tab, or a group whose open tabs sit in other windows: reopened where they sit.
    const one = history.closeAndSave(before, "a") as HistoryEntry;
    expect(one.label).toBe('close "A"');
    expect(one.undo).toEqual([{ kind: "reopen", ids: ["a"] }]);
    const withLive = applyOps(before, [ops.move("b", "g", 0)]);
    expect(history.closeAndSave(withLive, "g")?.undo).toEqual([{ kind: "reopen", ids: ["b"] }]);
    // A group with only saved tabs has nothing to close.
    expect(history.closeAndSave(before, "g")).toBeNull();
  });

  it("reopen: undo closes the tabs that were reopened, redo reopens them", () => {
    const before = fixture();
    const e = history.reopen(before, "g") as HistoryEntry;
    expect(e.label).toBe("reopen 3 tabs");
    expect(e.undo).toEqual([{ kind: "close", ids: ["s", "c2", "t"] }]);
    // A closed container reopens as a window; the redo names it so it comes back the same way.
    expect(e.redo).toEqual([{ kind: "reopen", ids: ["s", "c2", "t"], container: "g" }]);
    const single = history.reopen(before, "s") as HistoryEntry;
    expect(single.label).toBe("reopen 2 tabs"); // S and its saved child
    expect(single.redo).toEqual([{ kind: "reopen", ids: ["s", "c2"] }]);
    expect(history.reopen(before, "t")?.label).toBe('reopen "T"');
    // Nothing saved beneath a live window: nothing to record.
    expect(history.reopen(before, "w")).toBeNull();
    // A closed tab inside an open window reopens in place; no container in the step.
    const withClosed = applyOps(before, [ops.update("b", { liveTabId: null, liveWindowId: null })]);
    expect(history.reopen(withClosed, "w")?.redo).toEqual([{ kind: "reopen", ids: ["b"] }]);
    // Nested containers are windows of their own: their tabs are not part of the parent's reopen.
    const nested = applyOps(before, [
      ops.add(node("inner", "g", "window")),
      ops.add(tab("deep", "inner")),
    ]);
    expect(history.reopen(nested, "g")?.redo).toEqual([
      { kind: "reopen", ids: ["s", "c2", "t"], container: "g" },
    ]);
  });
});

describe("HistoryStack", () => {
  const entry = (label: string): HistoryEntry => ({
    label,
    done: label,
    undo: [{ kind: "ops", ops: [] }],
    redo: [{ kind: "ops", ops: [] }],
    ts: 1,
  });

  it("undo moves entries to redo, a new entry clears redo", () => {
    const s = new HistoryStack();
    expect(s.canUndo).toBe(false);
    s.push(entry("one"));
    s.push(entry("two"));
    expect(s.peekUndo()?.label).toBe("two");
    const e = s.takeUndo() as HistoryEntry;
    s.undone(e);
    expect(s.peekUndo()?.label).toBe("one");
    expect(s.peekRedo()?.label).toBe("two");
    const r = s.takeRedo() as HistoryEntry;
    s.redone(r);
    expect(s.peekUndo()?.label).toBe("two");
    expect(s.canRedo).toBe(false);
    s.undone(s.takeUndo() as HistoryEntry);
    s.push(entry("three"));
    expect(s.canRedo).toBe(false);
    expect(s.size).toBe(2);
  });

  it("keeps at most HISTORY_DEPTH entries, dropping the oldest", () => {
    const s = new HistoryStack();
    for (let i = 0; i < HISTORY_DEPTH + 10; i++) s.push(entry(`e${i}`));
    expect(s.size).toBe(HISTORY_DEPTH);
    expect(s.toJSON().undo[0]?.label).toBe("e10");
    expect(s.peekUndo()?.label).toBe(`e${HISTORY_DEPTH + 9}`);
  });

  it("round-trips through JSON and drops malformed entries", () => {
    const s = new HistoryStack();
    s.push(history.create(node("g", null, "window"), 0));
    s.push(history.remove(fixture(), [fixture().get("a") as TreeNode], "a") as HistoryEntry);
    s.push(history.reopen(fixture(), "g") as HistoryEntry); // carries `container`
    const raw = JSON.parse(JSON.stringify(s.toJSON())) as unknown;
    const back = HistoryStack.fromJSON(raw);
    expect(back.toJSON()).toEqual(s.toJSON());
    expect(back.peekUndo()?.redo).toEqual([
      { kind: "reopen", ids: ["s", "c2", "t"], container: "g" },
    ]);
    const dirty = HistoryStack.fromJSON({
      undo: [
        {
          label: "ok",
          undo: [{ kind: "delete", id: "x" }],
          redo: [{ kind: "reopen", ids: ["x"] }],
        },
        { label: "bad step", undo: [{ kind: "explode" }], redo: [] },
        { label: 5, undo: [], redo: [] },
        "junk",
      ],
      redo: "nope",
    });
    expect(back.canUndo).toBe(true);
    expect(dirty.toJSON().undo.map((e) => e.label)).toEqual(["ok"]);
    expect(dirty.toJSON().undo[0]?.done).toBe("ok");
    expect(dirty.canRedo).toBe(false);
    expect(HistoryStack.fromJSON(undefined).canUndo).toBe(false);
  });
});

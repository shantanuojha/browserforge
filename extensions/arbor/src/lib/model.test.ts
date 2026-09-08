import { describe, expect, it } from "vitest";
import {
  applyOp,
  applyOps,
  childrenOf,
  coerceNode,
  coerceOp,
  createTree,
  descendantIds,
  flattenTree,
  isSelfOrAncestor,
  makeNode,
  OpError,
  ops,
  resolveDrop,
  serializeNodes,
  validateTree,
  windowNodeOf,
  type NodeKind,
  type Tree,
} from "./model";

const T0 = 1_000;

function node(
  id: string,
  parentId: string | null,
  kind: NodeKind = "tab",
  live?: { tabId?: number; windowId?: number },
) {
  return makeNode({
    id,
    parentId,
    kind,
    title: id,
    ts: T0,
    liveTabId: live?.tabId,
    liveWindowId: live?.windowId,
  });
}

function fixture(): Tree {
  // w1
  //   a
  //   b
  //     b1
  //   c
  // w2
  let t = createTree();
  t = applyOps(t, [
    ops.add(node("w1", null, "window")),
    ops.add(node("a", "w1")),
    ops.add(node("b", "w1")),
    ops.add(node("b1", "b")),
    ops.add(node("c", "w1")),
    ops.add(node("w2", null, "window")),
  ]);
  return t;
}

const ids = (nodes: { id: string }[]) => nodes.map((n) => n.id);

describe("add", () => {
  it("appends at the end by default and renumbers order", () => {
    const t = fixture();
    expect(ids(childrenOf(t, "w1"))).toEqual(["a", "b", "c"]);
    expect(childrenOf(t, "w1").map((n) => n.order)).toEqual([0, 1, 2]);
  });

  it("inserts at an index", () => {
    const t = applyOp(fixture(), ops.add(node("x", "w1"), 1));
    expect(ids(childrenOf(t, "w1"))).toEqual(["a", "x", "b", "c"]);
    expect(childrenOf(t, "w1").map((n) => n.order)).toEqual([0, 1, 2, 3]);
  });

  it("clamps out-of-range indexes", () => {
    const t = applyOp(fixture(), ops.add(node("x", "w1"), 99));
    expect(ids(childrenOf(t, "w1"))).toEqual(["a", "b", "c", "x"]);
  });

  it("rejects duplicates and missing parents", () => {
    expect(() => applyOp(fixture(), ops.add(node("a", "w1")))).toThrow(OpError);
    expect(() => applyOp(fixture(), ops.add(node("z", "nope")))).toThrow(OpError);
  });

  it("does not mutate the input tree", () => {
    const t = fixture();
    applyOp(t, ops.add(node("x", "w1")));
    expect(t.has("x")).toBe(false);
  });
});

describe("update", () => {
  it("patches fields and removes undefined ones", () => {
    let t = applyOp(fixture(), ops.update("a", { note: "hello", liveTabId: 5 }), 2000);
    expect(t.get("a")?.note).toBe("hello");
    expect(t.get("a")?.liveTabId).toBe(5);
    expect(t.get("a")?.updatedAt).toBe(2000);
    t = applyOp(t, ops.update("a", { liveTabId: undefined }));
    expect("liveTabId" in (t.get("a") ?? {})).toBe(false);
  });

  it("collapse toggles the flag", () => {
    let t = applyOp(fixture(), ops.collapse("b", true));
    expect(t.get("b")?.collapsed).toBe(true);
    t = applyOp(t, ops.collapse("b", false));
    expect(t.get("b")?.collapsed).toBeUndefined();
  });

  it("rejects unknown nodes", () => {
    expect(() => applyOp(fixture(), ops.update("zz", { title: "x" }))).toThrow(OpError);
  });
});

describe("move", () => {
  it("reorders within the same parent", () => {
    const t = applyOp(fixture(), ops.move("c", "w1", 0));
    expect(ids(childrenOf(t, "w1"))).toEqual(["c", "a", "b"]);
    expect(childrenOf(t, "w1").map((n) => n.order)).toEqual([0, 1, 2]);
  });

  it("moves across parents and renumbers both", () => {
    const t = applyOp(fixture(), ops.move("b", "w2", 0));
    expect(ids(childrenOf(t, "w1"))).toEqual(["a", "c"]);
    expect(childrenOf(t, "w1").map((n) => n.order)).toEqual([0, 1]);
    expect(ids(childrenOf(t, "w2"))).toEqual(["b"]);
    expect(t.get("b")?.parentId).toBe("w2");
    // Subtree comes along.
    expect(t.get("b1")?.parentId).toBe("b");
  });

  it("nests under a sibling", () => {
    const t = applyOp(fixture(), ops.move("c", "a", 0));
    expect(ids(childrenOf(t, "a"))).toEqual(["c"]);
    expect(ids(childrenOf(t, "w1"))).toEqual(["a", "b"]);
  });

  it("moves to root", () => {
    const t = applyOp(fixture(), ops.move("b1", null, 1));
    expect(ids(childrenOf(t, null))).toEqual(["w1", "b1", "w2"]);
  });

  it("refuses cycles (into self or descendant)", () => {
    expect(() => applyOp(fixture(), ops.move("b", "b1", 0))).toThrow(/own subtree/);
    expect(() => applyOp(fixture(), ops.move("b", "b", 0))).toThrow(/own subtree/);
    expect(() => applyOp(fixture(), ops.move("w1", "b1", 0))).toThrow(OpError);
  });

  it("rejects missing nodes/parents", () => {
    expect(() => applyOp(fixture(), ops.move("zz", "w1", 0))).toThrow(OpError);
    expect(() => applyOp(fixture(), ops.move("a", "zz", 0))).toThrow(OpError);
  });
});

/**
 * Placement in the tree is presentation only (Tabs Outliner semantics): live windows, live tabs,
 * saved nodes and groups can all be nested under a group or reordered among any siblings.
 */
describe("move into groups (tree placement is independent of browser structure)", () => {
  // WORK (group, empty)
  // Window (live 7)
  //   t1 (live tab 11)
  //   t2 (live tab 12)
  //   saved (saved tab)
  // Other (group)
  //   inner (group)
  function grouped(): Tree {
    return applyOps(createTree(), [
      ops.add(node("WORK", null, "group")),
      ops.add(node("win", null, "window", { windowId: 7 })),
      ops.add(node("t1", "win", "tab", { tabId: 11, windowId: 7 })),
      ops.add(node("t2", "win", "tab", { tabId: 12, windowId: 7 })),
      ops.add(node("saved", "win")),
      ops.add(node("other", null, "group")),
      ops.add(node("inner", "other", "group")),
    ]);
  }

  it("moves a live window into a group; its subtree and live ids come along", () => {
    const t = applyOp(grouped(), ops.move("win", "WORK", 0));
    expect(ids(childrenOf(t, "WORK"))).toEqual(["win"]);
    expect(ids(childrenOf(t, null))).toEqual(["WORK", "other"]);
    expect(t.get("win")).toMatchObject({ parentId: "WORK", liveWindowId: 7 });
    expect(ids(childrenOf(t, "win"))).toEqual(["t1", "t2", "saved"]);
    expect(t.get("t1")?.liveTabId).toBe(11);
    expect(validateTree(t)).toEqual([]);
  });

  it("moves a live tab into a group without touching its live ids", () => {
    const t = applyOp(grouped(), ops.move("t1", "WORK", 0));
    expect(t.get("t1")).toMatchObject({ parentId: "WORK", liveTabId: 11, liveWindowId: 7 });
    expect(ids(childrenOf(t, "win"))).toEqual(["t2", "saved"]);
    expect(childrenOf(t, "win").map((n) => n.order)).toEqual([0, 1]);
    // The node keeps its identity, so later live updates still find it by id.
    const updated = applyOp(t, ops.update("t1", { title: "Renamed by the page" }));
    expect(updated.get("t1")).toMatchObject({ parentId: "WORK", title: "Renamed by the page" });
  });

  it("moves a saved tab and a live tab to the root", () => {
    let t = applyOp(grouped(), ops.move("saved", null, 0));
    expect(ids(childrenOf(t, null))).toEqual(["saved", "WORK", "win", "other"]);
    t = applyOp(t, ops.move("t2", null, 99));
    expect(ids(childrenOf(t, null))).toEqual(["saved", "WORK", "win", "other", "t2"]);
    expect(t.get("t2")?.liveTabId).toBe(12);
  });

  it("moves a group (with contents) into another group", () => {
    const t = applyOp(grouped(), ops.move("other", "WORK", 0));
    expect(ids(childrenOf(t, "WORK"))).toEqual(["other"]);
    expect(t.get("inner")?.parentId).toBe("other");
    expect(ids(childrenOf(t, null))).toEqual(["WORK", "win"]);
  });

  it("refuses to move a group into its own descendant", () => {
    expect(() => applyOp(grouped(), ops.move("other", "inner", 0))).toThrow(/own subtree/);
    expect(() => applyOp(grouped(), ops.move("WORK", "WORK", 0))).toThrow(/own subtree/);
    expect(() => applyOp(grouped(), ops.move("win", "t1", 0))).toThrow(/own subtree/);
  });

  it("reorders between siblings at every level", () => {
    let t = applyOp(grouped(), ops.move("other", null, 0));
    expect(ids(childrenOf(t, null))).toEqual(["other", "WORK", "win"]);
    t = applyOp(t, ops.move("saved", "win", 1));
    expect(ids(childrenOf(t, "win"))).toEqual(["t1", "saved", "t2"]);
    t = applyOp(t, ops.move("t1", "win", 2));
    expect(ids(childrenOf(t, "win"))).toEqual(["saved", "t2", "t1"]);
    expect(childrenOf(t, "win").map((n) => n.order)).toEqual([0, 1, 2]);
  });
});

describe("resolveDrop", () => {
  // WORK (group, empty)
  // win (live window)
  //   t1 (live tab)
  //   t2 (live tab)
  //   memo (note)
  // other (group)
  //   inner (group)
  function grouped(): Tree {
    return applyOps(createTree(), [
      ops.add(node("WORK", null, "group")),
      ops.add(node("win", null, "window", { windowId: 7 })),
      ops.add(node("t1", "win", "tab", { tabId: 11, windowId: 7 })),
      ops.add(node("t2", "win", "tab", { tabId: 12, windowId: 7 })),
      ops.add(node("memo", "win", "note")),
      ops.add(node("other", null, "group")),
      ops.add(node("inner", "other", "group")),
    ]);
  }

  it("drops a live window inside an empty group as its only child", () => {
    const t = grouped();
    expect(resolveDrop(t, "win", "WORK", "inside")).toEqual({ parentId: "WORK", index: 0 });
    const moved = applyOp(t, ops.move("win", "WORK", 0));
    expect(ids(childrenOf(moved, "WORK"))).toEqual(["win"]);
  });

  it("drops a live tab inside a group, appended last", () => {
    const t = applyOp(grouped(), ops.move("t2", "WORK", 0));
    expect(resolveDrop(t, "t1", "WORK", "inside")).toEqual({ parentId: "WORK", index: 1 });
  });

  it("drops a group inside another group", () => {
    expect(resolveDrop(grouped(), "other", "WORK", "inside")).toEqual({
      parentId: "WORK",
      index: 0,
    });
  });

  it("drops before/after a sibling, indexes ignoring the dragged node", () => {
    const t = grouped();
    expect(resolveDrop(t, "other", "WORK", "before")).toEqual({ parentId: null, index: 0 });
    expect(resolveDrop(t, "other", "WORK", "after")).toEqual({ parentId: null, index: 1 });
    // WORK is at index 0; dragging it after win (index 1) must not count WORK itself.
    expect(resolveDrop(t, "WORK", "win", "after")).toEqual({ parentId: null, index: 1 });
    expect(resolveDrop(t, "WORK", "other", "after")).toEqual({ parentId: null, index: 2 });
    // A live tab can sit between root siblings, and a group between live tabs.
    expect(resolveDrop(t, "t1", "WORK", "after")).toEqual({ parentId: null, index: 1 });
    expect(resolveDrop(t, "other", "t1", "before")).toEqual({ parentId: "win", index: 0 });
    expect(resolveDrop(t, "other", "t2", "after")).toEqual({ parentId: "win", index: 2 });
  });

  it("drops a live tab to the root when there is no target", () => {
    expect(resolveDrop(grouped(), "t1", null, "inside")).toEqual({ parentId: null, index: 3 });
    // Already at the root: excluded from the count.
    expect(resolveDrop(grouped(), "win", null, "inside")).toEqual({ parentId: null, index: 2 });
  });

  it("refuses a node onto itself or into its own subtree", () => {
    const t = grouped();
    expect(resolveDrop(t, "WORK", "WORK", "inside")).toBeNull();
    expect(resolveDrop(t, "WORK", "WORK", "after")).toBeNull();
    expect(resolveDrop(t, "other", "inner", "inside")).toBeNull();
    expect(resolveDrop(t, "other", "inner", "before")).toBeNull();
    expect(resolveDrop(t, "win", "t1", "inside")).toBeNull();
    expect(resolveDrop(t, "win", "t1", "after")).toBeNull();
  });

  it("refuses nesting under a note but allows dropping next to it", () => {
    const t = grouped();
    expect(resolveDrop(t, "t1", "memo", "inside")).toBeNull();
    expect(resolveDrop(t, "t1", "memo", "after")).toEqual({ parentId: "win", index: 2 });
  });

  it("refuses unknown ids", () => {
    expect(resolveDrop(grouped(), "ghost", "WORK", "inside")).toBeNull();
    expect(resolveDrop(grouped(), "t1", "ghost", "inside")).toBeNull();
  });

  it("agrees with the move op for every allowed destination", () => {
    const t = grouped();
    const cases: [string, string | null, "before" | "after" | "inside"][] = [
      ["win", "WORK", "inside"],
      ["t1", "WORK", "inside"],
      ["other", "WORK", "inside"],
      ["t2", "other", "before"],
      ["win", "inner", "after"],
      ["t1", null, "inside"],
    ];
    for (const [dragged, target, pos] of cases) {
      const dest = resolveDrop(t, dragged, target, pos);
      if (!dest) throw new Error(`${dragged} -> ${target}/${pos} was refused`);
      const moved = applyOp(t, ops.move(dragged, dest.parentId, dest.index));
      expect(moved.get(dragged)?.parentId).toBe(dest.parentId);
      expect(childrenOf(moved, dest.parentId)[dest.index]?.id).toBe(dragged);
      expect(validateTree(moved)).toEqual([]);
    }
  });
});

describe("remove", () => {
  it("removes the whole subtree and renumbers siblings", () => {
    const t = applyOp(fixture(), ops.remove("b"));
    expect(t.has("b")).toBe(false);
    expect(t.has("b1")).toBe(false);
    expect(ids(childrenOf(t, "w1"))).toEqual(["a", "c"]);
    expect(childrenOf(t, "w1").map((n) => n.order)).toEqual([0, 1]);
  });

  it("rejects unknown nodes", () => {
    expect(() => applyOp(fixture(), ops.remove("zz"))).toThrow(OpError);
  });
});

describe("queries", () => {
  it("descendantIds is depth-first", () => {
    expect(descendantIds(fixture(), "w1")).toEqual(["a", "b", "b1", "c"]);
  });

  it("isSelfOrAncestor", () => {
    const t = fixture();
    expect(isSelfOrAncestor(t, "w1", "b1")).toBe(true);
    expect(isSelfOrAncestor(t, "b1", "b1")).toBe(true);
    expect(isSelfOrAncestor(t, "b1", "w1")).toBe(false);
  });

  it("windowNodeOf finds the nearest window ancestor", () => {
    expect(windowNodeOf(fixture(), "b1")?.id).toBe("w1");
    expect(windowNodeOf(fixture(), "w2")?.id).toBe("w2");
  });

  it("flattenTree respects collapsed nodes", () => {
    const t = applyOp(fixture(), ops.collapse("b", true));
    const rows = flattenTree(t);
    expect(rows.map((r) => `${r.depth}:${r.node.id}`)).toEqual([
      "0:w1",
      "1:a",
      "1:b",
      "1:c",
      "0:w2",
    ]);
    expect(rows.find((r) => r.node.id === "b")?.hasChildren).toBe(true);
  });

  it("flattenTree with a filter shows matches and their ancestors, expanded", () => {
    const t = applyOp(fixture(), ops.collapse("b", true));
    const rows = flattenTree(t, (n) => n.id === "b1");
    expect(rows.map((r) => r.node.id)).toEqual(["w1", "b", "b1"]);
    expect(rows.map((r) => r.matched)).toEqual([false, false, true]);
  });

  it("serializeNodes is depth-first and complete", () => {
    expect(ids(serializeNodes(fixture()))).toEqual(["w1", "a", "b", "b1", "c", "w2"]);
  });

  it("validateTree reports missing parents and cycles", () => {
    const good = fixture();
    expect(validateTree(good)).toEqual([]);
    const bad = new Map(good);
    bad.set("orphan", node("orphan", "ghost"));
    const x = node("x", "y");
    const y = node("y", "x");
    bad.set("x", x);
    bad.set("y", y);
    const problems = validateTree(bad);
    expect(problems.some((p) => p.includes("missing parent"))).toBe(true);
    expect(problems.some((p) => p.includes("cycle"))).toBe(true);
  });
});

describe("coercion", () => {
  it("coerceNode accepts minimal input and drops junk", () => {
    const n = coerceNode({ id: "a", parentId: null, kind: "tab", title: 1, url: "https://x" });
    expect(n).toMatchObject({ id: "a", parentId: null, kind: "tab", title: "", url: "https://x" });
    expect(coerceNode({ id: "a", parentId: null, kind: "bogus" })).toBeUndefined();
    expect(coerceNode(null)).toBeUndefined();
  });

  it("coerceOp round-trips every op type", () => {
    const n = node("a", null);
    const cases = [
      { seq: 1, ts: 1, type: "add", node: n },
      { seq: 2, ts: 1, type: "add", node: n, index: 0 },
      { seq: 3, ts: 1, type: "update", id: "a", patch: { title: "b" } },
      { seq: 4, ts: 1, type: "move", id: "a", parentId: null, index: 2 },
      { seq: 5, ts: 1, type: "remove", id: "a" },
    ];
    for (const c of cases) expect(coerceOp(JSON.parse(JSON.stringify(c)))).toEqual(c);
    expect(coerceOp({ seq: 1, ts: 1, type: "explode" })).toBeUndefined();
    expect(coerceOp({ type: "remove", id: "a" })).toBeUndefined();
  });
});

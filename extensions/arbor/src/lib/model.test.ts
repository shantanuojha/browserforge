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
  serializeNodes,
  validateTree,
  windowNodeOf,
  type Tree,
} from "./model";

const T0 = 1_000;

function node(id: string, parentId: string | null, kind: "window" | "tab" | "group" = "tab") {
  return makeNode({ id, parentId, kind, title: id, ts: T0 });
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

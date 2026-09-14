import { describe, expect, it } from "vitest";
import { applyOps, childrenOf, createTree, makeNode, ops, validateTree } from "../model";
import { createExport, exportFileName, parseArborExport } from "./arbor-json";
import { materialize } from "./imported";
import { decodeInput, parseTabsOutliner } from "./tabs-outliner";

let n = 0;
const newId = () => `id${++n}`;

/**
 * Synthetic fixture in the shape we expect from Tabs Outliner: a session root holding
 * `[nodeSpec, [children]]` pairs, `data`/`marks` bags, a text note, a saved window and
 * some junk that must be ignored.
 */
const FIXTURE = [
  { type: "session", data: {} },
  [
    [
      { type: "win", data: { focused: true }, marks: { customTitle: "Work" }, colapsed: false },
      [
        [
          {
            type: "tab",
            data: { url: "https://a.test/", title: "A", favIconUrl: "https://a.test/f.ico" },
          },
        ],
        [
          { type: "tab", data: { url: "https://b.test/", title: "B" } },
          [[{ type: "tab", data: { url: "https://b.test/child", title: "B child" } }]],
        ],
        [{ type: "textnote", data: { note: "Remember to review" } }],
      ],
    ],
    [
      { type: "savedwin", data: {} },
      [[{ type: "savedtab", data: { url: "https://old.test/", title: "" } }]],
    ],
    [{ type: "group", data: { title: "Reading" } }, [[{ url: "https://c.test/", title: "C" }]]],
    { unrelated: 1 },
    "stray string",
    42,
  ],
];

describe("parseTabsOutliner", () => {
  it("recognises windows, tabs, nested tabs, notes and groups; windows and groups both become containers", () => {
    const preview = parseTabsOutliner(JSON.stringify(FIXTURE));
    expect(preview.counts).toEqual({ windows: 3, tabs: 5, notes: 1, total: 9 });
    const [work, saved, reading] = preview.roots;
    expect(work).toMatchObject({ kind: "window", title: "Work" });
    expect(work?.children.map((c) => c.title)).toEqual(["A", "B", "Remember to review"]);
    expect(work?.children[0]).toMatchObject({
      url: "https://a.test/",
      favIconUrl: "https://a.test/f.ico",
    });
    expect(work?.children[1]?.children[0]).toMatchObject({ kind: "tab", title: "B child" });
    expect(work?.children[2]).toMatchObject({ kind: "note", title: "Remember to review" });
    // An unnamed Tabs Outliner window stays untitled (Arbor shows it as "Window").
    expect(saved).toMatchObject({ kind: "window", title: "" });
    expect(saved?.children[0]).toMatchObject({
      kind: "tab",
      title: "old.test",
      url: "https://old.test/",
    });
    // A Tabs Outliner group is the same thing: a closed container with a name.
    expect(reading).toMatchObject({ kind: "window", title: "Reading" });
    expect(reading?.children[0]).toMatchObject({ kind: "tab", title: "C" });
    expect(preview.sample).toContain("A");
    expect(preview.warnings.some((w) => /not recognised/.test(w))).toBe(true);
    expect(preview.warnings.some((w) => /stray/.test(w))).toBe(true);
  });

  it("rebuilds the hierarchy of Tabs Outliner's flat row format ([flag, node, indexPath])", () => {
    // What `onViewClose_lastSessionSnapshot`, the IndexedDB `currentSessionSnapshot.data` and
    // exported .tree files actually contain (see the recovery scripts floating around: rows are
    // `[flag, { type, data, marks }, idxPath]`, rows in depth-first order, position encoded in
    // the index path rather than by nesting). Every node must land under its parent.
    const rows = [
      { version: 2 }, // header-like junk some dumps carry
      [1, { type: "win", data: { focused: true }, marks: { customTitle: "Work" } }, [0]],
      [1, { type: "tab", data: { url: "https://a.test/", title: "A" } }, [0, 0]],
      [1, { type: "tab", data: { url: "https://b.test/", title: "B" } }, [0, 1]],
      [1, { type: "tab", data: { url: "https://b.test/child", title: "B child" } }, [0, 1, 0]],
      [1, { type: "textnote", data: { note: "Remember to review" } }, [0, 2]],
      [1, { type: "savedwin", data: { crashDetectedDate: 1622000000000 } }, [1]],
      [1, { type: "savedtab", data: { url: "https://old.test/", title: "" } }, [1, 0]],
      [1, { type: "group", data: { title: "Reading" } }, [2]],
      [1, { type: "tab", data: { url: "https://c.test/", title: "C" } }, [2, 0]],
      // A row whose parent path is missing is hoisted rather than dropped.
      [1, { type: "tab", data: { url: "https://orphan.test/", title: "Orphan" } }, [7, 3]],
    ];
    const preview = parseTabsOutliner(JSON.stringify(rows));
    expect(preview.counts).toEqual({ windows: 3, tabs: 6, notes: 1, total: 10 });
    expect(preview.roots.map((r) => [r.kind, r.title])).toEqual([
      ["window", "Work"],
      ["window", ""],
      ["window", "Reading"],
      ["tab", "Orphan"],
    ]);
    const [work, saved, reading] = preview.roots;
    expect(work?.children.map((c) => c.title)).toEqual(["A", "B", "Remember to review"]);
    expect(work?.children[1]?.children.map((c) => c.title)).toEqual(["B child"]);
    expect(saved?.children.map((c) => c.url)).toEqual(["https://old.test/"]);
    expect(reading?.children.map((c) => c.title)).toEqual(["C"]);
    // Rows in a session root at path [] wrap the tree; an untitled one is unwrapped as before.
    const rooted = parseTabsOutliner([
      [1, { type: "session", data: {} }, []],
      [1, { type: "win", data: {} }, [0]],
      [1, { type: "tab", data: { url: "https://x.test/", title: "X" } }, [0, 0]],
    ]);
    expect(rooted.counts).toEqual({ windows: 1, tabs: 1, notes: 0, total: 2 });
    expect(rooted.roots[0]?.children[0]?.title).toBe("X");
  });

  it("accepts the raw localStorage value, double-encoded strings and the key wrapper", () => {
    const once = JSON.stringify(FIXTURE);
    const twice = JSON.stringify(once);
    expect(parseTabsOutliner(once).counts.total).toBe(9);
    expect(parseTabsOutliner(twice).counts.total).toBe(9);
    expect(parseTabsOutliner({ onViewClose_lastSessionSnapshot: once }).counts.total).toBe(9);
    expect(
      parseTabsOutliner(JSON.stringify({ onViewClose_lastSessionSnapshot: once })).counts.total,
    ).toBe(9);
  });

  it("accepts plain object trees with children/subnodes keys", () => {
    const preview = parseTabsOutliner({
      title: "My tree",
      subnodes: [
        { title: "W", type: "window", children: [{ url: "https://x.test/", title: "X" }] },
        { text: "a note" },
      ],
    });
    expect(preview.counts).toEqual({ windows: 2, tabs: 1, notes: 1, total: 4 });
    expect(preview.roots[0]?.title).toBe("My tree");
    // An untitled session/root wrapper is unwrapped.
    const wrapped = parseTabsOutliner([{ type: "session" }, [[{ url: "https://y.test/" }]]]);
    expect(wrapped.roots.map((r) => r.kind)).toEqual(["tab"]);
    // An unnamed group is titled "Group" (it is the user's; a plain window stays untitled).
    const unnamed = parseTabsOutliner([
      [{ type: "folder" }, [[{ url: "https://y.test/" }]]],
      [{ type: "win" }, [[{ url: "https://z.test/" }]]],
    ]);
    expect(unnamed.roots.map((r) => [r.kind, r.title])).toEqual([
      ["window", "Group"],
      ["window", ""],
    ]);
  });

  it("reports when nothing is recognised and rejects non-JSON", () => {
    expect(parseTabsOutliner("[1, 2, 3]").warnings[0]).toMatch(/No tabs/);
    expect(() => parseTabsOutliner("not json")).toThrow(/valid JSON/);
    expect(() => parseTabsOutliner("   ")).toThrow(/empty/);
    expect(decodeInput('"[]"')).toEqual([]);
  });

  it("never throws on hostile shapes", () => {
    const deep: unknown[] = [];
    let cur = deep;
    for (let i = 0; i < 400; i++) {
      const next: unknown[] = [];
      cur.push(next);
      cur = next;
    }
    const preview = parseTabsOutliner(deep);
    expect(preview.counts.total).toBe(0);
    const junk = parseTabsOutliner({ type: 5, data: null, children: "nope" });
    expect(junk.counts.total).toBe(0);
    expect(junk.warnings.length).toBeGreaterThan(0);
  });
});

describe("materialize", () => {
  it("produces a consistent flat tree with fresh ids under a wrapper group", () => {
    n = 0;
    const preview = parseTabsOutliner(JSON.stringify(FIXTURE));
    const nodes = materialize(preview.roots, { newId, now: () => 5, wrapTitle: "Imported" });
    expect(nodes.length).toBe(10);
    // The wrapper is a group: a closed container with a name, never bound to a window.
    expect(nodes[0]).toMatchObject({ kind: "window", title: "Imported", parentId: null });
    expect(nodes[0]?.liveWindowId).toBeUndefined();
    const tree = createTree(nodes);
    expect(validateTree(tree)).toEqual([]);
    expect(nodes.every((x) => x.liveTabId === undefined && x.liveWindowId === undefined)).toBe(
      true,
    );
    // Parents precede children so the nodes can be appended as `add` ops in order.
    const applied = applyOps(
      createTree(),
      nodes.map((x) => ops.add(x)),
    );
    expect(applied.size).toBe(10);
    const work = nodes.find((x) => x.title === "Work");
    expect(childrenOf(applied, work?.id ?? "").map((c) => c.title)).toEqual([
      "A",
      "B",
      "Remember to review",
    ]);
  });

  it("can import at the root", () => {
    const nodes = materialize([{ kind: "window", title: "G", children: [] }], { wrapTitle: null });
    expect(nodes.length).toBe(1);
    expect(nodes[0]?.parentId).toBeNull();
  });
});

describe("Arbor JSON export/import", () => {
  it("round-trips the current format (version 2) and strips live ids", () => {
    const w = makeNode({
      id: "w",
      parentId: null,
      kind: "window",
      title: "", // a window the browser opened: untitled
      liveWindowId: 3,
      ts: 1,
    });
    const t = makeNode({
      id: "t",
      parentId: "w",
      kind: "tab",
      title: "T",
      url: "https://t.test/",
      liveTabId: 9,
      liveWindowId: 3,
      note: "n",
      ts: 1,
    });
    const g = makeNode({ id: "g", parentId: null, kind: "window", title: "Reading", ts: 1 });
    const s = makeNode({ id: "s", parentId: "g", kind: "tab", title: "S", url: "https://s.test/" });
    const tree = applyOps(createTree(), [ops.add(w), ops.add(t), ops.add(g), ops.add(s)]);
    const exported = createExport(tree, 123);
    expect(exported).toMatchObject({
      format: "arbor-tree",
      version: 2,
      exportedAt: 123,
      nodeCount: 4,
    });
    expect(
      exported.nodes.every((x) => x.liveTabId === undefined && x.liveWindowId === undefined),
    ).toBe(true);
    expect(exported.nodes.map((x) => [x.id, x.kind, x.title])).toEqual([
      ["w", "window", ""],
      ["t", "tab", "T"],
      ["g", "window", "Reading"],
      ["s", "tab", "S"],
    ]);

    const preview = parseArborExport(JSON.stringify(exported));
    expect(preview.counts).toEqual({ windows: 2, tabs: 2, notes: 0, total: 4 });
    expect(preview.roots.map((r) => [r.kind, r.title])).toEqual([
      ["window", ""],
      ["window", "Reading"],
    ]);
    expect(preview.roots[0]?.children[0]).toMatchObject({
      title: "T",
      url: "https://t.test/",
      note: "n",
    });
    expect(preview.warnings).toEqual([]);
    // Materialised, the export reproduces the same shape, all closed.
    n = 0;
    const nodes = materialize(preview.roots, { newId, now: () => 5, wrapTitle: null });
    expect(nodes.map((x) => [x.kind, x.title, x.url ?? null])).toEqual([
      ["window", "", null],
      ["tab", "T", "https://t.test/"],
      ["window", "Reading", null],
      ["tab", "S", "https://s.test/"],
    ]);
    expect(nodes.every((x) => x.liveTabId === undefined && x.liveWindowId === undefined)).toBe(
      true,
    );
  });

  it("reads a version 1 export: groups become closed containers, 'Window' titles become empty", () => {
    const v1 = {
      format: "arbor-tree",
      version: 1,
      exportedAt: 1,
      nodeCount: 5,
      nodes: [
        { id: "w", parentId: null, kind: "window", title: "Window", order: 0 },
        { id: "t", parentId: "w", kind: "tab", title: "T", url: "https://t.test/", order: 0 },
        { id: "g", parentId: null, kind: "group", title: "Reading", order: 1 },
        { id: "s", parentId: "g", kind: "tab", title: "S", url: "https://s.test/", order: 0 },
        { id: "named", parentId: null, kind: "window", title: "Work", order: 2 },
      ],
    };
    const preview = parseArborExport(JSON.stringify(v1));
    expect(preview.warnings).toEqual([]);
    expect(preview.counts).toEqual({ windows: 3, tabs: 2, notes: 0, total: 5 });
    expect(preview.roots.map((r) => [r.kind, r.title])).toEqual([
      ["window", ""],
      ["window", "Reading"],
      ["window", "Work"],
    ]);
    expect(preview.roots[1]?.children[0]).toMatchObject({ kind: "tab", url: "https://s.test/" });
    // Re-exported, it is written in the current format.
    n = 0;
    const tree = applyOps(
      createTree(),
      materialize(preview.roots, { newId, now: () => 5, wrapTitle: null }).map((x) => ops.add(x)),
    );
    const again = createExport(tree, 2);
    expect(again.version).toBe(2);
    expect(again.nodes.every((x) => x.kind !== ("group" as string))).toBe(true);
    expect(childrenOf(tree, again.nodes[2]?.id ?? "").map((c) => c.title)).toEqual(["S"]);
  });

  it("lifts orphans and skips junk with warnings", () => {
    const preview = parseArborExport({
      format: "arbor-tree",
      version: 1,
      nodes: [
        { id: "a", parentId: "missing", kind: "tab", title: "A" },
        { id: "b", parentId: null, kind: "bogus", title: "B" },
        null,
      ],
    });
    expect(preview.counts.total).toBe(1);
    expect(preview.warnings.length).toBe(2);
  });

  it("rejects other formats", () => {
    expect(() => parseArborExport("{}")).toThrow(/Not an Arbor export/);
  });

  it("names export files by timestamp", () => {
    expect(exportFileName(new Date(2026, 8, 7, 14, 5))).toBe("arbor-20260907-1405.json");
  });
});

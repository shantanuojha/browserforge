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
  it("recognises windows, tabs, nested tabs, notes and groups", () => {
    const preview = parseTabsOutliner(JSON.stringify(FIXTURE));
    expect(preview.counts).toEqual({ windows: 2, tabs: 5, groups: 1, notes: 1, total: 9 });
    const [work, saved, reading] = preview.roots;
    expect(work).toMatchObject({ kind: "window", title: "Work" });
    expect(work?.children.map((c) => c.title)).toEqual(["A", "B", "Remember to review"]);
    expect(work?.children[0]).toMatchObject({
      url: "https://a.test/",
      favIconUrl: "https://a.test/f.ico",
    });
    expect(work?.children[1]?.children[0]).toMatchObject({ kind: "tab", title: "B child" });
    expect(work?.children[2]).toMatchObject({ kind: "note", title: "Remember to review" });
    expect(saved).toMatchObject({ kind: "window", title: "Window" });
    expect(saved?.children[0]).toMatchObject({
      kind: "tab",
      title: "old.test",
      url: "https://old.test/",
    });
    expect(reading).toMatchObject({ kind: "group", title: "Reading" });
    expect(reading?.children[0]).toMatchObject({ kind: "tab", title: "C" });
    expect(preview.sample).toContain("A");
    expect(preview.warnings.some((w) => /not recognised/.test(w))).toBe(true);
    expect(preview.warnings.some((w) => /stray/.test(w))).toBe(true);
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
    expect(preview.counts).toEqual({ windows: 1, tabs: 1, groups: 1, notes: 1, total: 4 });
    expect(preview.roots[0]?.title).toBe("My tree");
    // An untitled session/root wrapper is unwrapped.
    const wrapped = parseTabsOutliner([{ type: "session" }, [[{ url: "https://y.test/" }]]]);
    expect(wrapped.roots.map((r) => r.kind)).toEqual(["tab"]);
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
    expect(nodes[0]).toMatchObject({ kind: "group", title: "Imported", parentId: null });
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
    const nodes = materialize([{ kind: "group", title: "G", children: [] }], { wrapTitle: null });
    expect(nodes.length).toBe(1);
    expect(nodes[0]?.parentId).toBeNull();
  });
});

describe("Arbor JSON export/import", () => {
  it("round-trips and strips live ids", () => {
    const w = makeNode({
      id: "w",
      parentId: null,
      kind: "window",
      title: "W",
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
    const tree = applyOps(createTree(), [ops.add(w), ops.add(t)]);
    const exported = createExport(tree, 123);
    expect(exported).toMatchObject({
      format: "arbor-tree",
      version: 1,
      exportedAt: 123,
      nodeCount: 2,
    });
    expect(
      exported.nodes.every((x) => x.liveTabId === undefined && x.liveWindowId === undefined),
    ).toBe(true);

    const preview = parseArborExport(JSON.stringify(exported));
    expect(preview.counts).toEqual({ windows: 1, tabs: 1, groups: 0, notes: 0, total: 2 });
    expect(preview.roots[0]?.children[0]).toMatchObject({
      title: "T",
      url: "https://t.test/",
      note: "n",
    });
    expect(preview.warnings).toEqual([]);
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

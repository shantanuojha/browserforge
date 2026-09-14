import { describe, expect, it } from "vitest";
import { migrationOps } from "./migrate";
import { applyOps, createTree, makeNode, ops } from "./model";
import { MemoryLogBackend, MemoryTreeStore } from "./store/memory";
import { FakeBrowser, newId } from "./sync/testing/fake-browser";
import { TabTracker } from "./sync/tracker";

describe("migrationOps", () => {
  it("turns the old 'Window' default title into the empty title, and nothing else", () => {
    const tree = applyOps(createTree(), [
      ops.add(makeNode({ id: "auto", parentId: null, kind: "window", title: "Window", ts: 1 })),
      ops.add(makeNode({ id: "named", parentId: null, kind: "window", title: "Work", ts: 1 })),
      ops.add(makeNode({ id: "fresh", parentId: null, kind: "window", title: "", ts: 1 })),
      ops.add(makeNode({ id: "t", parentId: "auto", kind: "tab", title: "Window", ts: 1 })),
      ops.add(makeNode({ id: "n", parentId: "auto", kind: "note", title: "Window", ts: 1 })),
    ]);
    expect(migrationOps(tree)).toEqual([ops.update("auto", { title: "" })]);
    // Idempotent: once applied there is nothing left to do.
    expect(migrationOps(applyOps(tree, migrationOps(tree)))).toEqual([]);
  });
});

/**
 * Trees written before 0.1.4 used `kind: "group"` for user groups and titled browser windows
 * "Window". Both are read into the unified model without touching the stored records: the kind
 * at read time, the title as ops the first rebuild logs.
 */
describe("loading a pre-0.1.4 tree", () => {
  const old = (id: string, parentId: string | null, kind: string, title: string, order = 0) => ({
    id,
    parentId,
    kind,
    title,
    createdAt: 1,
    updatedAt: 1,
    order,
  });

  it("reads group nodes from a snapshot and the op log as unbound containers, logs the title migration once", async () => {
    const backend = new MemoryLogBackend();
    backend.snapshots.set(4, {
      seq: 4,
      ts: 1,
      nodeCount: 4,
      nodes: [
        old("w", null, "window", "Window", 0),
        { ...old("a", "w", "tab", "A"), url: "https://a.test/" },
        old("g", null, "group", "Reading", 1),
        { ...old("s", "g", "tab", "S"), url: "https://s.test/" },
      ],
    });
    backend.ops.set(5, {
      seq: 5,
      ts: 2,
      type: "add",
      node: old("inner", "g", "group", "Nested", 1),
    });
    const store = new MemoryTreeStore(backend);
    const report = await store.open();
    expect(report).toMatchObject({ replayed: 1, quarantined: 0, skippedSnapshots: 0 });
    const tree = store.getTree();
    expect(tree.get("g")).toMatchObject({ kind: "window", title: "Reading", parentId: null });
    expect(tree.get("inner")).toMatchObject({ kind: "window", title: "Nested", parentId: "g" });
    expect(tree.get("g")?.liveWindowId).toBeUndefined();
    expect([...tree.values()].some((n) => (n.kind as string) === "group")).toBe(false);

    // The first rebuild normalises the old default title as ordinary ops...
    const fb = new FakeBrowser();
    const tracker = new TabTracker(store, fb, { newId, now: () => 1 });
    fb.tracker = tracker;
    const rebuilt = await tracker.rebuild();
    expect(rebuilt.migrated).toBe(1);
    expect(store.getTree().get("w")).toMatchObject({ title: "" });
    expect(store.getTree().get("g")).toMatchObject({ title: "Reading" });
    await store.flush();
    const logged = [...backend.ops.values()].map((raw) => raw as { type: string; id?: string });
    expect(logged.some((o) => o.type === "update" && o.id === "w")).toBe(true);
    // ...and only once.
    expect((await tracker.rebuild()).migrated).toBe(0);

    // The next compaction writes the snapshot in the new shape.
    const snap = await store.compact(true);
    expect(snap?.nodes.map((n) => [n.id, n.kind, n.title])).toEqual([
      ["w", "window", ""],
      ["a", "tab", "A"],
      ["g", "window", "Reading"],
      ["s", "tab", "S"],
      ["inner", "window", "Nested"],
    ]);
  });
});

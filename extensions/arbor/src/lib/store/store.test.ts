import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { childrenOf, makeNode, OpError, ops, type Op, type TreeNode } from "../model";
import { IndexedDbLogBackend, IndexedDbTreeStore } from "./indexeddb";
import { LogTreeStore } from "./engine";
import { MemoryLogBackend, MemoryTreeStore } from "./memory";
import { asIdbFactory, FakeIDBFactory, installFakeIndexedDb } from "./testing/fake-indexeddb";
import type { LogBackend, TreeStore } from "./types";

function node(id: string, parentId: string | null, kind: TreeNode["kind"] = "tab"): TreeNode {
  return makeNode({ id, parentId, kind, title: id, ts: 1 });
}

function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

async function seed(store: TreeStore, n: number, parent = "w"): Promise<void> {
  store.append([ops.add(node(parent, null, "window"))]);
  for (let i = 0; i < n; i++) store.append([ops.add(node(`${parent}-t${i}`, parent))]);
  await store.flush();
}

describe("LogTreeStore (memory backend)", () => {
  it("starts empty and persists ops in the log", async () => {
    const mem = new MemoryLogBackend();
    const store = new MemoryTreeStore(mem);
    const report = await store.open();
    expect(report).toMatchObject({ snapshotSeq: 0, replayed: 0, quarantined: 0 });

    const written = store.append([ops.add(node("w", null, "window")), ops.add(node("t", "w"))]);
    expect(written.map((o) => o.seq)).toEqual([1, 2]);
    expect(store.getTree().size).toBe(2);
    expect(mem.ops.size).toBe(0); // not flushed yet
    await store.flush();
    expect(mem.ops.size).toBe(2);
  });

  it("rejects invalid ops atomically and does not burn sequence numbers", async () => {
    const store = new MemoryTreeStore();
    await store.open();
    store.append([ops.add(node("w", null, "window"))]);
    expect(
      () => store.append([ops.add(node("a", "w")), ops.move("w", "a", 0)]), // second op is a cycle
    ).toThrow(OpError);
    expect(store.getTree().has("a")).toBe(false);
    const [next] = store.append([ops.add(node("b", "w"))]);
    expect(next?.seq).toBe(2);
  });

  it("reopens from the log and replays", async () => {
    const mem = new MemoryLogBackend();
    const a = new MemoryTreeStore(mem);
    await a.open();
    await seed(a, 5);
    a.append([ops.update("w-t2", { note: "keep me" })]);
    await a.close();

    const b = new MemoryTreeStore(mem);
    const report = await b.open();
    expect(report.replayed).toBe(7);
    expect(report.snapshotSeq).toBe(0);
    expect(b.getTree().get("w-t2")?.note).toBe("keep me");
    // Sequence numbers continue after the highest seen.
    const [op] = b.append([ops.add(node("x", "w"))]);
    expect(op?.seq).toBe(8);
  });

  it("compacts every N ops and truncates the log", async () => {
    const mem = new MemoryLogBackend();
    const store = new MemoryTreeStore(mem, { compactEveryOps: 10 });
    await store.open();
    await seed(store, 8); // 9 ops
    expect(mem.snapshots.size).toBe(0);
    store.append([ops.add(node("more", "w"))]); // 10th -> compaction scheduled
    await store.flush();
    await store.compact(); // wait for the queue to settle (no-op if already compacted)
    expect(mem.snapshots.size).toBe(1);
    const [snapSeq] = [...mem.snapshots.keys()];
    expect(snapSeq).toBe(10);
    expect(mem.ops.size).toBe(0);
    const metas = await store.listSnapshots();
    expect(metas).toEqual([{ seq: 10, ts: expect.any(Number), nodeCount: 10 }]);
  });

  it("compacts on the time threshold via compactIfDue", async () => {
    const c = clock();
    const mem = new MemoryLogBackend();
    const store = new MemoryTreeStore(mem, { compactIntervalMs: 5 * 60_000, now: c.now });
    await store.open();
    await seed(store, 2);
    expect(await store.compactIfDue()).toBe(false);
    c.advance(4 * 60_000);
    expect(await store.compactIfDue()).toBe(false);
    c.advance(60_001);
    expect(await store.compactIfDue()).toBe(true);
    expect(mem.snapshots.size).toBe(1);
    // Nothing pending -> nothing to do even after a long time.
    c.advance(60 * 60_000);
    expect(await store.compactIfDue()).toBe(false);
  });

  it("keeps only the newest N snapshots", async () => {
    const mem = new MemoryLogBackend();
    const store = new MemoryTreeStore(mem, { snapshotRetention: 3 });
    await store.open();
    store.append([ops.add(node("w", null, "window"))]);
    for (let i = 0; i < 6; i++) {
      store.append([ops.add(node(`t${i}`, "w"))]);
      await store.compact();
    }
    const metas = await store.listSnapshots();
    expect(metas.length).toBe(3);
    expect(metas.map((m) => m.seq)).toEqual([7, 6, 5]);
  });

  it("replays ops on top of the latest snapshot on reopen", async () => {
    const mem = new MemoryLogBackend();
    const a = new MemoryTreeStore(mem);
    await a.open();
    await seed(a, 3);
    await a.compact();
    a.append([ops.add(node("after", "w"))]);
    await a.close();

    const b = new MemoryTreeStore(mem);
    const report = await b.open();
    expect(report.snapshotSeq).toBe(4);
    expect(report.replayed).toBe(1);
    expect(b.getTree().has("after")).toBe(true);
    expect(b.getTree().size).toBe(5);
  });

  it("quarantines ops that fail to replay and keeps the snapshot", async () => {
    const mem = new MemoryLogBackend();
    const a = new MemoryTreeStore(mem);
    await a.open();
    await seed(a, 3);
    await a.compact();
    a.append([ops.add(node("good", "w"))]);
    await a.flush();
    // Corrupt the log: an op referencing a node that never existed, plus unreadable junk.
    const badOp: Op = { seq: 6, ts: 1, type: "move", id: "ghost", parentId: "w", index: 0 };
    mem.ops.set(6, badOp);
    mem.ops.set(7, { seq: 7, ts: 1, type: "explode" });
    const goodAfter: Op = { seq: 8, ts: 1, type: "update", id: "good", patch: { note: "n" } };
    mem.ops.set(8, goodAfter);

    const b = new MemoryTreeStore(mem);
    const report = await b.open();
    expect(report.snapshotSeq).toBe(4);
    expect(report.replayed).toBe(2);
    expect(report.quarantined).toBe(1);
    expect(b.getTree().has("good")).toBe(true);
    expect(b.getTree().get("good")?.note).toBe("n");
    const q = await b.listQuarantine();
    expect(q.length).toBe(1);
    expect(q[0]?.op.seq).toBe(6);
    expect(q[0]?.reason).toMatch(/ghost/);
    // The log was repaired: bad records removed and state pinned in a new snapshot.
    expect(mem.ops.has(6)).toBe(false);
    expect(mem.ops.has(7)).toBe(false);
    const metas = await b.listSnapshots();
    expect(metas[0]?.seq).toBe(8);
    expect(metas[0]?.nodeCount).toBe(5);
    // New ops continue after the quarantined seqs.
    const [op] = b.append([ops.add(node("z", "w"))]);
    expect(op?.seq).toBe(9);
  });

  it("falls back to an older snapshot when the latest is inconsistent", async () => {
    const mem = new MemoryLogBackend();
    const a = new MemoryTreeStore(mem);
    await a.open();
    await seed(a, 2);
    await a.compact(); // seq 3
    a.append([ops.add(node("later", "w"))]);
    await a.compact(); // seq 4
    // Break the newest snapshot: an orphaned node.
    const raw = (await mem.getSnapshot(4)) as { nodes: TreeNode[] };
    raw.nodes.push(node("orphan", "missing-parent"));
    mem.snapshots.set(4, raw);

    const b = new MemoryTreeStore(mem);
    const report = await b.open();
    expect(report.snapshotSeq).toBe(3);
    expect(report.skippedSnapshots).toBe(1);
    expect(report.warnings[0]).toMatch(/inconsistent/);
    expect(b.getTree().size).toBe(3);
  });

  it("restoreSnapshot makes an old snapshot current without deleting history", async () => {
    const mem = new MemoryLogBackend();
    const store = new MemoryTreeStore(mem);
    await store.open();
    await seed(store, 2);
    await store.compact(); // seq 3, 3 nodes
    store.append([ops.remove("w-t0"), ops.add(node("new", "w"))]);
    await store.compact(); // seq 5, 3 nodes
    expect(store.getTree().has("w-t0")).toBe(false);

    const tree = await store.restoreSnapshot(3);
    expect(tree.has("w-t0")).toBe(true);
    expect(tree.has("new")).toBe(false);
    const metas = await store.listSnapshots();
    expect(metas.map((m) => m.seq)).toEqual([6, 5, 3]);
    expect(mem.ops.size).toBe(0);

    // Subsequent ops work and reopen yields the restored state.
    store.append([ops.add(node("after-restore", "w"))]);
    await store.close();
    const again = new MemoryTreeStore(mem);
    await again.open();
    expect(again.getTree().has("w-t0")).toBe(true);
    expect(again.getTree().has("after-restore")).toBe(true);
    await expect(store.restoreSnapshot(999)).rejects.toThrow();
  });

  it("replaceTree validates and pins the new tree", async () => {
    const store = new MemoryTreeStore();
    await store.open();
    await seed(store, 1);
    await store.replaceTree([node("r", null, "group"), node("c", "r")]);
    expect([...store.getTree().keys()].sort()).toEqual(["c", "r"]);
    await expect(store.replaceTree([node("x", "nope")])).rejects.toThrow(/inconsistent/);
  });

  it("notifies subscribers with the applied ops", async () => {
    const store = new MemoryTreeStore();
    await store.open();
    const seen: (readonly Op[] | null)[] = [];
    const off = store.subscribe((_tree, applied) => seen.push(applied));
    store.append([ops.add(node("w", null, "window"))]);
    expect(seen.length).toBe(1);
    expect(seen[0]?.[0]?.type).toBe("add");
    off();
    store.append([ops.add(node("t", "w"))]);
    expect(seen.length).toBe(1);
  });

  it("re-queues pending ops when a flush fails", async () => {
    const mem = new MemoryLogBackend();
    const store = new MemoryTreeStore(mem);
    await store.open();
    store.append([ops.add(node("w", null, "window"))]);
    mem.failNextWrite = new Error("disk full");
    await expect(store.flush()).rejects.toThrow("disk full");
    expect(mem.ops.size).toBe(0);
    await store.flush();
    expect(mem.ops.size).toBe(1);
  });

  it("orders siblings after moves survive a round-trip", async () => {
    const mem = new MemoryLogBackend();
    const a = new MemoryTreeStore(mem);
    await a.open();
    await seed(a, 3);
    a.append([ops.move("w-t2", "w", 0)]);
    await a.close();
    const b = new MemoryTreeStore(mem);
    await b.open();
    expect(childrenOf(b.getTree(), "w").map((n) => n.id)).toEqual(["w-t2", "w-t0", "w-t1"]);
  });
});

describe("IndexedDbLogBackend (fake IndexedDB)", () => {
  let installed: ReturnType<typeof installFakeIndexedDb>;
  beforeEach(() => {
    installed = installFakeIndexedDb();
  });
  afterEach(() => {
    installed.restore();
  });

  const roundTrip = async (backend: LogBackend) => {
    const store = new LogTreeStore(backend, { flushDelayMs: 0 });
    await store.open();
    await seed(store, 3);
    await store.compact();
    store.append([ops.add(node("after", "w"))]);
    await store.close();
  };

  it("persists ops, snapshots and metadata through the raw IDB API", async () => {
    const factory = new FakeIDBFactory();
    await roundTrip(new IndexedDbLogBackend(asIdbFactory(factory)));
    expect(factory.peek("arbor", "snapshotMeta")).toEqual([
      { seq: 4, ts: expect.any(Number), nodeCount: 4 },
    ]);
    expect(factory.peek("arbor", "ops").length).toBe(1);

    const reopened = new IndexedDbTreeStore({ flushDelayMs: 0 }, asIdbFactory(factory));
    const report = await reopened.open();
    expect(report).toMatchObject({ snapshotSeq: 4, replayed: 1, quarantined: 0 });
    expect(reopened.getTree().size).toBe(5);
    expect((await reopened.listSnapshots()).map((m) => m.seq)).toEqual([4]);
    await reopened.close();
  });

  it("quarantines corrupt ops stored in IndexedDB", async () => {
    const factory = new FakeIDBFactory();
    await roundTrip(new IndexedDbLogBackend(asIdbFactory(factory)));
    factory.poke("arbor", "ops", 6, {
      seq: 6,
      ts: 1,
      type: "remove",
      id: "does-not-exist",
    });
    const store = new IndexedDbTreeStore({ flushDelayMs: 0 }, asIdbFactory(factory));
    const report = await store.open();
    expect(report.quarantined).toBe(1);
    expect((await store.listQuarantine())[0]?.op.seq).toBe(6);
    expect(factory.peek("arbor", "ops")).toEqual([]);
    expect(factory.peek("arbor", "snapshotMeta").length).toBe(2);
    await store.close();
  });

  it("works through the global indexedDB when installed", async () => {
    const store = new IndexedDbTreeStore({ flushDelayMs: 0 });
    await store.open();
    store.append([ops.add(node("w", null, "window"))]);
    await store.flush();
    expect(installed.factory.peek("arbor", "ops").length).toBe(1);
    await store.close();
  });
});

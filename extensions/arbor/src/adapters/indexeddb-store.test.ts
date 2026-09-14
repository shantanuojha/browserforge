import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeNode, ops, type TreeNode } from "../lib/model";
import { LogTreeStore } from "../lib/store/engine";
import type { LogBackend, TreeStore } from "../lib/store/types";
import { IndexedDbLogBackend, IndexedDbTreeStore } from "./indexeddb-store";
import { asIdbFactory, FakeIDBFactory, installFakeIndexedDb } from "./testing/fake-indexeddb";

const NOW = () => 1;
const OPTIONS = { flushDelayMs: 0, now: NOW };

function node(id: string, parentId: string | null, kind: TreeNode["kind"] = "tab"): TreeNode {
  return makeNode({ id, parentId, kind, title: id, ts: 1 });
}

async function seed(store: TreeStore, n: number, parent = "w"): Promise<void> {
  store.append([ops.add(node(parent, null, "window"))]);
  for (let i = 0; i < n; i++) store.append([ops.add(node(`${parent}-t${i}`, parent))]);
  await store.flush();
}

describe("IndexedDbLogBackend (fake IndexedDB)", () => {
  let installed: ReturnType<typeof installFakeIndexedDb>;
  beforeEach(() => {
    installed = installFakeIndexedDb();
  });
  afterEach(() => {
    installed.restore();
  });

  const roundTrip = async (backend: LogBackend) => {
    const store = new LogTreeStore(backend, OPTIONS);
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

    const reopened = new IndexedDbTreeStore(OPTIONS, asIdbFactory(factory));
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
    const store = new IndexedDbTreeStore(OPTIONS, asIdbFactory(factory));
    const report = await store.open();
    expect(report.quarantined).toBe(1);
    expect((await store.listQuarantine())[0]?.op.seq).toBe(6);
    expect(factory.peek("arbor", "ops")).toEqual([]);
    expect(factory.peek("arbor", "snapshotMeta").length).toBe(2);
    await store.close();
  });

  it("works through the global indexedDB when installed", async () => {
    const store = new IndexedDbTreeStore(OPTIONS);
    await store.open();
    store.append([ops.add(node("w", null, "window"))]);
    await store.flush();
    expect(installed.factory.peek("arbor", "ops").length).toBe(1);
    await store.close();
  });
});

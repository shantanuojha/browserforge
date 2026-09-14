import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRule, type Rule } from "../rules/model";
import { createMemorySyncArea, createSyncStore, type SyncStore } from "../sync/store";
import { createSyncMirror } from "./sync-mirror";
import { createRecordingRecorder } from "./testing";

const rule = (id: string) =>
  createRule({ id, include: `https://${id}/*`, redirectTo: "https://t/$1" });
const DEBOUNCE_MS = 100;

function setup(options: { pro?: boolean; syncEnabled?: boolean; local?: Rule[] } = {}) {
  const area = createMemorySyncArea();
  const clock = { now: 10_000 };
  const store = createSyncStore(area, () => clock.now);
  const state = { rules: options.local ?? [], syncEnabled: options.syncEnabled ?? true };
  const recorder = createRecordingRecorder();
  const saved: Rule[][] = [];
  const mirror = createSyncMirror({
    store,
    isPro: async () => options.pro ?? true,
    saveLocalRules: async (rules) => {
      saved.push(rules);
      state.rules = rules;
    },
    recorder,
    view: () => state,
    origin: "me",
    debounceMs: DEBOUNCE_MS,
  });
  return { area, store, state, mirror, saved, recorder, clock };
}

/** Fires the debounce; the write itself finishes on a real macrotask (compression stream). */
async function settle(store: SyncStore) {
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
  await vi.waitFor(async () => expect(await store.read()).not.toBeNull());
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

describe("sync mirror", () => {
  it("publishes local rules after the debounce, once, under this device's origin", async () => {
    const { store, state, mirror } = setup({ local: [rule("a")] });
    mirror.scheduleWrite();
    state.rules = [rule("a"), rule("b")];
    mirror.scheduleWrite();
    await settle(store);
    const snapshot = await store.read();
    expect(snapshot?.rules.map((r) => r.id)).toEqual(["a", "b"]);
    expect(snapshot?.meta.origin).toBe("me");
  });

  it("does nothing without Pro or with sync switched off", async () => {
    const free = setup({ pro: false, local: [rule("a")] });
    free.mirror.scheduleWrite();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(await free.store.read()).toBeNull();

    const off = setup({ syncEnabled: false, local: [rule("a")] });
    off.mirror.scheduleWrite();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(await off.store.read()).toBeNull();
  });

  it("join adopts a remote set merged with local rules", async () => {
    const { store, mirror, saved } = setup({ local: [rule("local")] });
    await store.write([rule("remote")], "other");
    await mirror.join();
    expect(saved).toEqual([[rule("remote"), rule("local")]]);
  });

  it("join publishes the local rules when nothing is in sync yet", async () => {
    const { store, mirror, saved } = setup({ local: [rule("local")] });
    await mirror.join();
    await settle(store);
    expect(saved).toEqual([]);
    expect((await store.read())?.rules.map((r) => r.id)).toEqual(["local"]);
  });

  it("applies newer remote snapshots but ignores its own echo and stale ones", async () => {
    const { store, mirror, saved, clock } = setup({ local: [rule("a")] });
    mirror.scheduleWrite();
    await settle(store);

    await mirror.applyRemoteChange(); // our own write echoing back
    expect(saved).toEqual([]);

    clock.now = 20_000;
    await store.write([rule("b")], "other");
    await mirror.applyRemoteChange();
    expect(saved).toEqual([[rule("b")]]);

    clock.now = 5_000;
    await store.write([rule("c")], "other");
    await mirror.applyRemoteChange(); // older than what we already applied
    expect(saved).toHaveLength(1);
  });

  it("records a failed write in the activity log", async () => {
    const { mirror, recorder, store } = setup({ local: [rule("a")] });
    vi.spyOn(store, "write").mockRejectedValue(new Error("quota"));
    mirror.scheduleWrite();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    await vi.waitFor(() => expect(recorder.events[0]?.detail).toBe("Sync write failed: quota"));
  });
});

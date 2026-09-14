import { describe, expect, it } from "vitest";
import { createRule } from "../rules/model";
import {
  SYNC_CHUNK_PREFIX,
  SYNC_META_KEY,
  chunkString,
  decodePayload,
  encodePayload,
  mergeRulesOnJoin,
} from "./codec";
import { createMemorySyncArea, createSyncStore } from "./store";

/** Incompressible filler so the payload really spans several chunks. */
function noise(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

const bigRuleSet = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    createRule({
      id: `r${i}`,
      name: `Rule ${i} ${noise(40)}`,
      include: `https://${noise(24)}.example/${noise(40)}/*`,
      redirectTo: `https://${noise(24)}.example/${noise(40)}/$1`,
    }),
  );

function setup() {
  const area = createMemorySyncArea();
  const store = createSyncStore(area, () => 1_000);
  return { area, store };
}

describe("sync codec", () => {
  it("chunkString splits exactly", () => {
    expect(chunkString("")).toEqual([]);
    expect(chunkString("abcdef", 4)).toEqual(["abcd", "ef"]);
    expect(chunkString("abcd", 4)).toEqual(["abcd"]);
  });

  it("encode/decode round-trip (compressed when available)", async () => {
    const text = JSON.stringify({ hello: "w\u00f6rld".repeat(50) });
    const { data, compressed } = await encodePayload(text);
    expect(typeof compressed).toBe("boolean");
    expect(await decodePayload(data, compressed)).toBe(text);
  });

  it("mergeRulesOnJoin keeps the remote order and appends local-only rules", () => {
    const r = (id: string) =>
      createRule({ id, include: `https://${id}/*`, redirectTo: "https://x/" });
    const remote = [r("a"), r("b")];
    const local = [r("b"), r("c")];
    expect(mergeRulesOnJoin(remote, local).map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(mergeRulesOnJoin([], local)).toEqual(local);
    expect(mergeRulesOnJoin(remote, [])).toEqual(remote);
  });
});

describe("sync store", () => {
  it("writes a manifest plus chunks that fit the per-item quota and reads them back", async () => {
    const { area, store } = setup();
    const rules = bigRuleSet(300);
    const meta = await store.write(rules, "me");
    expect(meta.chunks).toBeGreaterThan(1);
    expect(meta.updatedAt).toBe(1_000);
    expect(area.data.get(SYNC_META_KEY)).toEqual(meta);
    for (let i = 0; i < meta.chunks; i++) {
      const chunk = area.data.get(`${SYNC_CHUNK_PREFIX}${i}`) as string;
      expect(chunk.length).toBeLessThanOrEqual(7_000);
      expect(JSON.stringify(chunk).length + SYNC_CHUNK_PREFIX.length + 3).toBeLessThan(8_192);
    }

    const snapshot = await store.read();
    expect(snapshot?.errors).toEqual([]);
    expect(snapshot?.rules).toEqual(rules);
    expect(snapshot?.meta.origin).toBe("me");
  });

  it("removes stale chunks when the payload shrinks", async () => {
    const { area, store } = setup();
    const big = bigRuleSet(300);
    const first = await store.write(big, "a");
    const second = await store.write(big.slice(0, 2), "a");
    expect(second.chunks).toBeLessThan(first.chunks);
    const chunkKeys = [...area.data.keys()].filter((k) => k.startsWith(SYNC_CHUNK_PREFIX));
    expect(chunkKeys).toHaveLength(second.chunks);
    expect((await store.read())?.rules).toHaveLength(2);
  });

  it("clear removes everything it wrote and nothing else", async () => {
    const { area, store } = setup();
    area.data.set("someone-elses-key", 1);
    await store.write(bigRuleSet(3), "a");
    await store.clear();
    expect([...area.data.keys()]).toEqual(["someone-elses-key"]);
    expect(await store.read()).toBeNull();
  });

  it("reads null while a write is partial", async () => {
    const area = createMemorySyncArea({
      [SYNC_META_KEY]: { v: 1, updatedAt: 1, chunks: 2, bytes: 10, origin: "x", compressed: false },
      [`${SYNC_CHUNK_PREFIX}0`]: "abc",
    });
    expect(await createSyncStore(area).read()).toBeNull();
  });

  it("reports a corrupt payload as errors instead of throwing", async () => {
    const area = createMemorySyncArea({
      [SYNC_META_KEY]: { v: 1, updatedAt: 1, chunks: 1, bytes: 3, origin: "x", compressed: false },
      [`${SYNC_CHUNK_PREFIX}0`]: "!!!not base64 json!!!",
    });
    const snapshot = await createSyncStore(area).read();
    expect(snapshot?.rules).toEqual([]);
    expect(snapshot?.errors).toHaveLength(1);
  });
});

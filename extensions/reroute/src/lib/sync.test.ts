// Use WXT's fake-browser instance: it is the one `wxt/browser` resolves to under WxtVitest.
import { beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { createRule } from "./rules/model";
import {
  SYNC_CHUNK_PREFIX,
  SYNC_META_KEY,
  chunkString,
  clearSync,
  decodePayload,
  encodePayload,
  readRulesFromSync,
  writeRulesToSync,
} from "./sync";

/** Incompressible filler so the payload really spans several chunks. */
function noise(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

describe("sync chunking", () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    await fakeBrowser.storage.sync.clear();
  });

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

  it("writes a manifest plus chunks and reads them back", async () => {
    const rules = Array.from({ length: 300 }, (_, i) =>
      createRule({
        id: `r${i}`,
        name: `Rule ${i} ${noise(40)}`,
        include: `https://${noise(24)}.example/${noise(40)}/*`,
        redirectTo: `https://${noise(24)}.example/${noise(40)}/$1`,
      }),
    );
    const meta = await writeRulesToSync(rules, "me");
    expect(meta.chunks).toBeGreaterThan(1);
    const stored = await fakeBrowser.storage.sync.get(null);
    expect(stored[SYNC_META_KEY]).toEqual(meta);
    for (let i = 0; i < meta.chunks; i++) {
      const chunk = stored[`${SYNC_CHUNK_PREFIX}${i}`] as string;
      expect(chunk.length).toBeLessThanOrEqual(7_000);
      expect(JSON.stringify(chunk).length + SYNC_CHUNK_PREFIX.length + 3).toBeLessThan(8_192);
    }

    const snap = await readRulesFromSync();
    expect(snap?.errors).toEqual([]);
    expect(snap?.rules).toEqual(rules);
    expect(snap?.meta.origin).toBe("me");
  });

  it("removes stale chunks when the payload shrinks and clears cleanly", async () => {
    const big = Array.from({ length: 300 }, (_, i) =>
      createRule({
        id: `r${i}`,
        include: `https://${noise(40)}.example/*`,
        redirectTo: `https://${noise(40)}/$1`,
      }),
    );
    const first = await writeRulesToSync(big, "a");
    const second = await writeRulesToSync(big.slice(0, 2), "a");
    expect(second.chunks).toBeLessThan(first.chunks);
    const stored = await fakeBrowser.storage.sync.get(null);
    const chunkKeys = Object.keys(stored).filter((k) => k.startsWith(SYNC_CHUNK_PREFIX));
    expect(chunkKeys).toHaveLength(second.chunks);
    expect((await readRulesFromSync())?.rules).toHaveLength(2);

    await clearSync();
    expect(Object.keys(await fakeBrowser.storage.sync.get(null))).toEqual([]);
    expect(await readRulesFromSync()).toBeNull();
  });

  it("returns null while a write is partial", async () => {
    await fakeBrowser.storage.sync.set({
      [SYNC_META_KEY]: { v: 1, updatedAt: 1, chunks: 2, bytes: 10, origin: "x", compressed: false },
      [`${SYNC_CHUNK_PREFIX}0`]: "abc",
    });
    expect(await readRulesFromSync()).toBeNull();
  });
});

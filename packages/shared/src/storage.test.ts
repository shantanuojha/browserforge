import { fakeBrowser } from "@webext-core/fake-browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineStorageKey, localStorage } from "./storage.js";

// storage.ts reads the `chrome` global at call time; point it at the in-memory fake.
(globalThis as unknown as { chrome: unknown }).chrome = fakeBrowser;

describe("StorageArea", () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it("get returns the fallback only when the key is absent", async () => {
    expect(await localStorage.get("k", "fb")).toBe("fb");
    await localStorage.set("k", 0);
    expect(await localStorage.get("k", "fb")).toBe(0);
    await localStorage.set("k", "");
    expect(await localStorage.get("k", "fb")).toBe("");
  });

  it("set(key, undefined) clears the key instead of silently keeping the old value", async () => {
    const item = defineStorageKey<string | undefined>("k", undefined);
    await item.set("v");
    expect(await item.get()).toBe("v");
    await item.set(undefined);
    expect(await item.get()).toBeUndefined();
    expect(await fakeBrowser.storage.local.get("k")).toEqual({});
  });

  it("watch reports next/prev with the fallback substituted", async () => {
    const item = defineStorageKey<number>("n", 0);
    const seen = vi.fn();
    const stop = item.watch(seen);
    await item.set(5);
    expect(seen).toHaveBeenLastCalledWith(5, 0);
    await item.set(undefined as unknown as number);
    expect(seen).toHaveBeenLastCalledWith(0, 5);
    stop();
    await item.set(7);
    expect(seen).toHaveBeenCalledTimes(2);
  });
});

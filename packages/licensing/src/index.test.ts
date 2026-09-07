import { describe, expect, it } from "vitest";
import { FREE_ENTITLEMENTS, getEntitlements } from "./index";

describe("getEntitlements (placeholder)", () => {
  it("resolves to a non-Pro user", async () => {
    await expect(getEntitlements()).resolves.toEqual({ pro: false });
  });

  it("returns a fresh object each call", async () => {
    const a = await getEntitlements();
    const b = await getEntitlements();
    expect(a).not.toBe(b);
    expect(a).not.toBe(FREE_ENTITLEMENTS);
  });
});

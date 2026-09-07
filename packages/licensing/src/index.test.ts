import { afterEach, describe, expect, it } from "vitest";
import {
  FREE_ENTITLEMENTS,
  configureLicensing,
  createLicenseClient,
  getEntitlements,
} from "./index";
import { RAW_KEY, activatedBody, createFakeFetch, createMemoryStorage } from "./test-utils";

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

describe("getEntitlements with a client", () => {
  afterEach(() => configureLicensing(undefined));

  function proClient() {
    const { fetch } = createFakeFetch(() => ({ json: activatedBody() }));
    return createLicenseClient({ productName: "arbor", storage: createMemoryStorage(), fetch });
  }

  it("reflects the explicit client's state", async () => {
    const client = proClient();
    await expect(getEntitlements(client)).resolves.toEqual({ pro: false });
    await client.activate(RAW_KEY);
    await expect(getEntitlements(client)).resolves.toEqual({ pro: true });
  });

  it("falls back to the module-level configured client", async () => {
    const client = proClient();
    await client.activate(RAW_KEY);
    configureLicensing(client);
    await expect(getEntitlements()).resolves.toEqual({ pro: true });
    configureLicensing(undefined);
    await expect(getEntitlements()).resolves.toEqual({ pro: false });
  });
});

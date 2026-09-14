import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { getEntitlements, licenseStorageKey } from "@browserforge/licensing";
import {
  RAW_KEY,
  activatedBody,
  createFakeFetch,
  createMemoryStorage,
  validBody,
  type Responder,
} from "@browserforge/licensing/testing";
import { ENV, PRO_PAGE_URL, readLicensingConfig } from "../lib/licensing-config";
import {
  LICENSING,
  createRerouteLicenseClient,
  getLicenseClient,
  isPro,
  onLicenseChange,
  resetLicensingForTests,
  setupLicensing,
} from "./licensing";

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse("2026-09-01T00:00:00Z");
const VARIANT_ID = 9191;
const bodyFor = { variantId: VARIANT_ID, instanceName: "reroute@chrome-abc123" };

const CONFIGURED = readLicensingConfig({
  [ENV.storeId]: "7",
  [ENV.variantId]: String(VARIANT_ID),
  [ENV.checkoutUrl]: "https://browserforge.lemonsqueezy.com/checkout/buy/def",
});

describe("readLicensingConfig", () => {
  it("is not configured when the env vars are absent, and falls back to the product page", () => {
    const config = readLicensingConfig({});
    expect(config.configured).toBe(false);
    expect(config.storeId).toBeUndefined();
    expect(config.variantId).toBeUndefined();
    expect(config.checkoutUrl).toBe(PRO_PAGE_URL);
    expect(config.productName).toBe("reroute");
  });

  it("parses numeric ids and an https checkout URL", () => {
    expect(CONFIGURED.configured).toBe(true);
    expect(CONFIGURED.storeId).toBe(7);
    expect(CONFIGURED.variantId).toBe(VARIANT_ID);
    expect(CONFIGURED.checkoutUrl).toBe("https://browserforge.lemonsqueezy.com/checkout/buy/def");
  });

  it("treats malformed values as unset", () => {
    expect(readLicensingConfig({ [ENV.storeId]: "7", [ENV.variantId]: "abc" }).configured).toBe(
      false,
    );
    expect(readLicensingConfig({ [ENV.storeId]: "", [ENV.variantId]: "1" }).configured).toBe(false);
    expect(
      readLicensingConfig({ [ENV.variantId]: "1", [ENV.checkoutUrl]: "http://insecure.example" })
        .checkoutUrl,
    ).toBe(PRO_PAGE_URL);
  });

  it("does not create a client when not configured", () => {
    expect(createRerouteLicenseClient(readLicensingConfig({}))).toBeUndefined();
  });
});

describe("extension-level licence client", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    resetLicensingForTests();
  });
  afterEach(() => resetLicensingForTests());

  function setup(responder: Responder) {
    const storage = createMemoryStorage();
    const { fetch, calls } = createFakeFetch(responder);
    const clock = { t: T0 };
    const client = setupLicensing(CONFIGURED, {
      storage,
      fetch,
      now: () => clock.t,
      userAgent: "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/128.0 Safari/537.36",
    });
    if (!client) throw new Error("client expected");
    return { client, storage, calls, clock };
  }

  it("activation success flips entitlements and the Pro gate", async () => {
    const { client, calls, storage } = setup(() => ({ json: activatedBody({}, bodyFor) }));

    await expect(isPro()).resolves.toBe(false);
    await expect(getEntitlements()).resolves.toEqual({ pro: false });

    const res = await client.activate(RAW_KEY);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.kind).toBe("pro");
    if (res.value.kind !== "pro") return;
    expect(res.value.key).toBe("XXXX-…-4d51");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.endpoint).toBe("activate");
    expect(calls[0]?.body.license_key).toBe(RAW_KEY);
    expect(calls[0]?.body.instance_name).toMatch(/^reroute@chrome-[a-z0-9]{6}$/);

    expect(storage.data.has(licenseStorageKey("reroute"))).toBe(true);
    expect(JSON.stringify(res.value)).not.toContain(RAW_KEY);

    await expect(isPro()).resolves.toBe(true);
    await expect(getEntitlements()).resolves.toEqual({ pro: true });
    expect(getLicenseClient()).toBe(client);
  });

  it("activation failure (activation limit) keeps the free tier", async () => {
    const { client } = setup(() => ({
      status: 400,
      json: {
        activated: false,
        error: "This license key has reached the activation limit.",
        license_key: { status: "active", activation_limit: 1, activation_usage: 1 },
      },
    }));
    const res = await client.activate(RAW_KEY);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("activation_limit");
    await expect(isPro()).resolves.toBe(false);
  });

  it("activation failure (invalid key) keeps the free tier", async () => {
    const { client } = setup(() => ({
      status: 404,
      json: { activated: false, error: "license_key not found." },
    }));
    const res = await client.activate("not-a-real-key");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("invalid_key");
    await expect(isPro()).resolves.toBe(false);
  });

  it("rejects keys bought for another product and releases the seat", async () => {
    const { client, calls } = setup((endpoint) =>
      endpoint === "activate"
        ? { json: activatedBody({}, { ...bodyFor, variantId: VARIANT_ID + 1 }) }
        : { json: { deactivated: true } },
    );
    const res = await client.activate(RAW_KEY);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("wrong_product");
    expect(calls.map((c) => c.endpoint)).toEqual(["activate", "deactivate"]);
    await expect(isPro()).resolves.toBe(false);
  });

  it("network failure keeps Pro during the offline grace period, then degrades to free", async () => {
    let online = true;
    const { client, clock } = setup((endpoint) => {
      if (!online) return new Error("offline");
      return {
        json: endpoint === "activate" ? activatedBody({}, bodyFor) : validBody({}, bodyFor),
      };
    });
    await client.activate(RAW_KEY);
    await expect(isPro()).resolves.toBe(true);

    online = false;
    clock.t = T0 + 8 * DAY; // past the 7-day revalidation interval
    const graced = await client.validate();
    expect(graced.kind).toBe("grace");
    await expect(isPro()).resolves.toBe(true);
    await expect(getEntitlements()).resolves.toEqual({ pro: true });

    clock.t = T0 + 15 * DAY; // past the 14-day grace period
    const expired = await client.validate();
    expect(expired).toEqual({ kind: "free", reason: "grace_expired" });
    await expect(isPro()).resolves.toBe(false);

    online = true;
    const restored = await client.validate({ force: true });
    expect(restored.kind).toBe("pro");
    await expect(isPro()).resolves.toBe(true);
  });

  it("deactivation flips entitlements back to free", async () => {
    const { client } = setup((endpoint) =>
      endpoint === "deactivate"
        ? { json: { deactivated: true } }
        : { json: activatedBody({}, bodyFor) },
    );
    await client.activate(RAW_KEY);
    await expect(isPro()).resolves.toBe(true);
    const res = await client.deactivate();
    expect(res.ok).toBe(true);
    await expect(isPro()).resolves.toBe(false);
  });

  it("onLicenseChange fires for changes made through the client", async () => {
    const { client } = setup(() => ({ json: activatedBody({}, bodyFor) }));
    const seen = vi.fn();
    const stop = onLicenseChange(seen);
    await client.activate(RAW_KEY);
    expect(seen).toHaveBeenCalled();
    stop();
    seen.mockClear();
    await client.validate({ force: true });
    expect(seen).not.toHaveBeenCalled();
  });

  it("stays on the free tier without crashing when licensing is not configured", async () => {
    const client = setupLicensing(readLicensingConfig({}));
    expect(client).toBeUndefined();
    expect(getLicenseClient()).toBeUndefined();
    await expect(isPro()).resolves.toBe(false);
    await expect(getEntitlements()).resolves.toEqual({ pro: false });
    const stop = onLicenseChange(() => undefined);
    expect(() => stop()).not.toThrow();
  });

  it("uses browser.storage.local by default", async () => {
    const { fetch } = createFakeFetch(() => ({ json: activatedBody({}, bodyFor) }));
    const client = setupLicensing(CONFIGURED, { fetch, now: () => T0 });
    if (!client) throw new Error("client expected");
    await client.activate(RAW_KEY);
    const stored = await fakeBrowser.storage.local.get(licenseStorageKey("reroute"));
    expect(stored[licenseStorageKey("reroute")]).toMatchObject({
      kind: "activated",
      key: RAW_KEY,
    });
    await expect(isPro()).resolves.toBe(true);
  });

  it("the build-time config comes from import.meta.env (unset in tests)", () => {
    expect(LICENSING.productName).toBe("reroute");
    expect(typeof LICENSING.configured).toBe("boolean");
  });
});

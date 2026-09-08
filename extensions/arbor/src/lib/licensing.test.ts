import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { getEntitlements, licenseStorageKey, type LicenseStorage } from "@browserforge/licensing";
import {
  ENV,
  LICENSING,
  PRO_PAGE_URL,
  createArborLicenseClient,
  getLicenseClient,
  onLicenseChange,
  readLicensingConfig,
  resetLicensingForTests,
  setupLicensing,
} from "./licensing";
import { isPro } from "./pro";

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse("2026-09-01T00:00:00Z");
const VARIANT_ID = 4242;
const RAW_KEY = "38b1460a-5104-4067-a91d-77b872934d51";
const INSTANCE_ID = "5bd6ff3b-9dd8-4fd2-9d7f-1ccb4a1ca2a1";

const CONFIGURED = readLicensingConfig({
  [ENV.storeId]: "7",
  [ENV.variantId]: String(VARIANT_ID),
  [ENV.checkoutUrl]: "https://browserforge.lemonsqueezy.com/checkout/buy/abc",
});

function memoryStorage(): LicenseStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of typeof keys === "string" ? [keys] : keys)
        if (data.has(k)) out[k] = data.get(k);
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of typeof keys === "string" ? [keys] : keys) data.delete(k);
    },
  };
}

type Answer = { status?: number; json: unknown } | Error;
type Responder = (endpoint: string, body: Record<string, string>) => Answer;

/** `fetch` double: records calls and answers through `responder`. */
function fakeFetch(responder: Responder) {
  const calls: { endpoint: string; body: Record<string, string> }[] = [];
  const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
    const endpoint = input.slice(input.lastIndexOf("/") + 1);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
    calls.push({ endpoint, body });
    const answer = responder(endpoint, body);
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer.json), {
      status: answer.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { fetch: fetchImpl, calls };
}

function activatedBody(variantId = VARIANT_ID) {
  return {
    activated: true,
    error: null,
    license_key: { id: 1, status: "active", key: RAW_KEY, activation_limit: 3, expires_at: null },
    instance: { id: INSTANCE_ID, name: "arbor@chrome-abc123" },
    meta: { store_id: 7, product_id: 9, variant_id: variantId, customer_email: "pat@example.com" },
  };
}

function validBody() {
  return { ...activatedBody(), activated: undefined, valid: true };
}

describe("readLicensingConfig", () => {
  it("is not configured when the env vars are absent, and falls back to the product page", () => {
    const config = readLicensingConfig({});
    expect(config.configured).toBe(false);
    expect(config.storeId).toBeUndefined();
    expect(config.variantId).toBeUndefined();
    expect(config.checkoutUrl).toBe(PRO_PAGE_URL);
    expect(config.productName).toBe("arbor");
  });

  it("parses numeric ids and an https checkout URL", () => {
    expect(CONFIGURED.configured).toBe(true);
    expect(CONFIGURED.storeId).toBe(7);
    expect(CONFIGURED.variantId).toBe(VARIANT_ID);
    expect(CONFIGURED.checkoutUrl).toBe("https://browserforge.lemonsqueezy.com/checkout/buy/abc");
  });

  it("treats malformed values as unset", () => {
    expect(readLicensingConfig({ [ENV.storeId]: "7", [ENV.variantId]: "abc" }).configured).toBe(
      false,
    );
    expect(readLicensingConfig({ [ENV.storeId]: "", [ENV.variantId]: "1" }).configured).toBe(false);
    expect(readLicensingConfig({ [ENV.storeId]: "7", [ENV.variantId]: "-1" }).configured).toBe(
      false,
    );
    expect(
      readLicensingConfig({ [ENV.variantId]: "1", [ENV.checkoutUrl]: "http://insecure.example" })
        .checkoutUrl,
    ).toBe(PRO_PAGE_URL);
    expect(readLicensingConfig({ [ENV.checkoutUrl]: "not a url" }).checkoutUrl).toBe(PRO_PAGE_URL);
  });

  it("does not create a client when not configured", () => {
    expect(createArborLicenseClient(readLicensingConfig({}))).toBeUndefined();
  });
});

describe("extension-level licence client", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    resetLicensingForTests();
  });
  afterEach(() => resetLicensingForTests());

  function setup(responder: Responder) {
    const storage = memoryStorage();
    const { fetch, calls } = fakeFetch(responder);
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
    const { client, calls, storage } = setup(() => ({ json: activatedBody() }));

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
    expect(calls[0]?.body.instance_name).toMatch(/^arbor@chrome-[a-z0-9]{6}$/);

    // The raw key lives only in storage, never in the exposed state.
    expect(storage.data.has(licenseStorageKey("arbor"))).toBe(true);
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
        ? { json: activatedBody(VARIANT_ID + 1) }
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
      return { json: endpoint === "activate" ? activatedBody() : validBody() };
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
      endpoint === "deactivate" ? { json: { deactivated: true } } : { json: activatedBody() },
    );
    await client.activate(RAW_KEY);
    await expect(isPro()).resolves.toBe(true);
    const res = await client.deactivate();
    expect(res.ok).toBe(true);
    await expect(isPro()).resolves.toBe(false);
  });

  it("onLicenseChange fires for changes made through the client", async () => {
    const { client } = setup(() => ({ json: activatedBody() }));
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
    const { fetch } = fakeFetch(() => ({ json: activatedBody() }));
    const client = setupLicensing(CONFIGURED, { fetch, now: () => T0 });
    if (!client) throw new Error("client expected");
    await client.activate(RAW_KEY);
    const stored = await fakeBrowser.storage.local.get(licenseStorageKey("arbor"));
    expect(stored[licenseStorageKey("arbor")]).toMatchObject({ kind: "activated", key: RAW_KEY });
    await expect(isPro()).resolves.toBe(true);
  });

  it("the build-time config comes from import.meta.env (unset in tests)", () => {
    expect(LICENSING.productName).toBe("arbor");
    expect(typeof LICENSING.configured).toBe("boolean");
  });
});

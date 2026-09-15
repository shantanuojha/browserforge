import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { getEntitlements, licenseStorageKey } from "@browserforge/licensing";
import {
  POLAR_ACTIVATION_ID,
  POLAR_BENEFIT_ID,
  POLAR_KEY,
  POLAR_ORG_ID,
  RAW_KEY,
  VARIANT_ID,
  activatedBody,
  createFakeFetch,
  createMemoryStorage,
  polarFixtures,
  validBody,
  type Responder,
} from "@browserforge/licensing/testing";
import { ENV, PRO_PAGE_URL, readLicensingConfig } from "../lib/licensing-config";
import {
  LICENSING,
  createArborLicenseClient,
  getLicenseClient,
  isPro,
  onLicenseChange,
  resetLicensingForTests,
  setupLicensing,
} from "./licensing";

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse("2026-09-01T00:00:00Z");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/128.0 Safari/537.36";

const CONFIGURED = readLicensingConfig({
  [ENV.storeId]: "7",
  [ENV.variantId]: String(VARIANT_ID),
  [ENV.lemonSqueezyCheckoutUrl]: "https://browserforge.lemonsqueezy.com/checkout/buy/abc",
});

const POLAR_ENV = {
  [ENV.organizationId]: POLAR_ORG_ID,
  [ENV.benefitId]: POLAR_BENEFIT_ID,
  [ENV.polarCheckoutUrl]: "https://buy.polar.sh/polar_cl_arbor",
  [ENV.polarOrgSlug]: "browserforge",
};
const POLAR_CONFIGURED = readLicensingConfig(POLAR_ENV);

describe("readLicensingConfig", () => {
  it("is not configured when the env vars are absent, and falls back to the product page", () => {
    const config = readLicensingConfig({});
    expect(config.configured).toBe(false);
    expect(config.provider).toBe("lemonsqueezy");
    expect(config.settings).toBeUndefined();
    expect(config.checkoutUrl).toBe(PRO_PAGE_URL);
    expect(config.productName).toBe("arbor");
  });

  it("parses Lemon Squeezy ids and an https checkout URL", () => {
    expect(CONFIGURED.configured).toBe(true);
    expect(CONFIGURED.provider).toBe("lemonsqueezy");
    expect(CONFIGURED.settings).toEqual({
      name: "lemonsqueezy",
      storeId: 7,
      variantId: VARIANT_ID,
    });
    expect(CONFIGURED.checkoutUrl).toBe("https://browserforge.lemonsqueezy.com/checkout/buy/abc");
    expect(CONFIGURED.restoreUrl).toBe("https://app.lemonsqueezy.com/my-orders");
  });

  it("infers Polar from its ids and uses its checkout link and customer portal", () => {
    expect(POLAR_CONFIGURED.configured).toBe(true);
    expect(POLAR_CONFIGURED.provider).toBe("polar");
    expect(POLAR_CONFIGURED.settings).toEqual({
      name: "polar",
      organizationId: POLAR_ORG_ID,
      benefitId: POLAR_BENEFIT_ID,
    });
    expect(POLAR_CONFIGURED.checkoutUrl).toBe("https://buy.polar.sh/polar_cl_arbor");
    expect(POLAR_CONFIGURED.restoreUrl).toBe("https://polar.sh/browserforge/portal");
    expect(POLAR_CONFIGURED.restoreHint).toMatch(/Polar/);
  });

  it("lets WXT_LICENSE_PROVIDER pick the provider when both sets of ids are present", () => {
    const both = { ...POLAR_ENV, [ENV.storeId]: "7", [ENV.variantId]: String(VARIANT_ID) };
    expect(readLicensingConfig(both).provider).toBe("polar");
    const explicit = readLicensingConfig({ ...both, [ENV.provider]: "lemonsqueezy" });
    expect(explicit.provider).toBe("lemonsqueezy");
    expect(explicit.settings?.name).toBe("lemonsqueezy");
  });

  it("uses the sandbox portal when the API base is the sandbox", () => {
    const sandbox = readLicensingConfig({
      ...POLAR_ENV,
      [ENV.polarApiBase]: "https://sandbox-api.polar.sh",
    });
    expect(sandbox.settings).toMatchObject({ apiBase: "https://sandbox-api.polar.sh" });
    expect(sandbox.restoreUrl).toBe("https://sandbox.polar.sh/browserforge/portal");
  });

  it("treats malformed values as unset", () => {
    expect(readLicensingConfig({ [ENV.storeId]: "7", [ENV.variantId]: "abc" }).configured).toBe(
      false,
    );
    expect(readLicensingConfig({ [ENV.storeId]: "", [ENV.variantId]: "1" }).configured).toBe(false);
    expect(readLicensingConfig({ [ENV.storeId]: "7", [ENV.variantId]: "-1" }).configured).toBe(
      false,
    );
    expect(readLicensingConfig({ ...POLAR_ENV, [ENV.benefitId]: "not-a-uuid" }).configured).toBe(
      false,
    );
    expect(
      readLicensingConfig({
        [ENV.variantId]: "1",
        [ENV.lemonSqueezyCheckoutUrl]: "http://insecure.example",
      }).checkoutUrl,
    ).toBe(PRO_PAGE_URL);
    expect(
      readLicensingConfig({ ...POLAR_ENV, [ENV.polarCheckoutUrl]: "not a url" }).checkoutUrl,
    ).toBe(PRO_PAGE_URL);
  });

  it("does not create a client when not configured", () => {
    expect(createArborLicenseClient(readLicensingConfig({}))).toBeUndefined();
    expect(
      createArborLicenseClient(readLicensingConfig({ [ENV.provider]: "polar" })),
    ).toBeUndefined();
  });
});

describe("extension-level licence client (Polar)", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    resetLicensingForTests();
  });
  afterEach(() => resetLicensingForTests());

  function setupPolar(responder: Responder, config = POLAR_CONFIGURED) {
    const storage = createMemoryStorage();
    const { fetch, calls } = createFakeFetch(responder);
    const client = setupLicensing(config, {
      storage,
      fetch,
      now: () => T0,
      userAgent: USER_AGENT,
    });
    if (!client) throw new Error("client expected");
    return { client, storage, calls, fetch };
  }

  it("activates against api.polar.sh with the org id and benefit scoping", async () => {
    const { client, calls, fetch, storage } = setupPolar((endpoint) =>
      endpoint === "activate"
        ? { json: polarFixtures.activateOk() }
        : { json: polarFixtures.validateOk() },
    );
    const res = await client.activate(POLAR_KEY);
    expect(res.ok && res.value.kind).toBe("pro");
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.polar.sh/v1/customer-portal/license-keys/activate",
    );
    expect(calls[0]?.body).toEqual({
      key: POLAR_KEY,
      organization_id: POLAR_ORG_ID,
      label: expect.stringMatching(/^arbor@chrome-[a-z0-9]{6}$/),
    });
    await expect(isPro()).resolves.toBe(true);
    expect(storage.data.get(licenseStorageKey("arbor"))).toMatchObject({
      v: 2,
      provider: "polar",
      instanceId: POLAR_ACTIVATION_ID,
    });

    await client.validate({ force: true });
    expect(calls[1]?.body).toMatchObject({ benefit_id: POLAR_BENEFIT_ID });
  });

  it("uses the sandbox origin when WXT_POLAR_API_BASE says so", async () => {
    const sandbox = readLicensingConfig({
      ...POLAR_ENV,
      [ENV.polarApiBase]: "https://sandbox-api.polar.sh",
    });
    const { client, fetch } = setupPolar(() => ({ json: polarFixtures.activateOk() }), sandbox);
    await client.activate(POLAR_KEY);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://sandbox-api.polar.sh/v1/customer-portal/license-keys/activate",
    );
  });

  it("rejects a key for another benefit and releases the seat", async () => {
    const other = polarFixtures.activateOk();
    other.license_key.benefit_id = "e1e1e1e1-0000-4000-8000-000000000000";
    const { client, calls } = setupPolar((endpoint) =>
      endpoint === "activate" ? { json: other } : { status: 204 },
    );
    const res = await client.activate(POLAR_KEY);
    expect(!res.ok && res.error.code).toBe("wrong_product");
    expect(calls.map((c) => c.endpoint)).toEqual(["activate", "deactivate"]);
    await expect(isPro()).resolves.toBe(false);
  });

  it("shows a Lemon Squeezy record as invalid and re-activates the same key on Polar", async () => {
    const { client, storage, calls } = setupPolar(() => ({ json: polarFixtures.activateOk() }));
    await storage.set({
      [licenseStorageKey("arbor")]: {
        v: 1,
        kind: "activated",
        key: RAW_KEY,
        instanceId: "old",
        instanceName: "arbor@chrome-old",
        lastValidatedAt: T0,
      },
    });
    expect((await client.getState()).kind).toBe("invalid");
    await expect(isPro()).resolves.toBe(false);
    const res = await client.activate(RAW_KEY);
    expect(res.ok && res.value.kind).toBe("pro");
    expect(calls.map((c) => c.endpoint)).toEqual(["activate"]);
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
      userAgent: USER_AGENT,
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
        ? { json: activatedBody({}, { variantId: VARIANT_ID + 1 }) }
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
    const { fetch } = createFakeFetch(() => ({ json: activatedBody() }));
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
    expect(["lemonsqueezy", "polar"]).toContain(LICENSING.provider);
  });
});

/**
 * The licence client driven through the real Polar adapter: proves the state machine in
 * `client.ts` is unchanged when the provider is Polar, and covers the provider switch itself
 * (stored record v2, v1 migration, provider mismatch).
 */
import { describe, expect, it } from "vitest";
import { createLicenseClient } from "./client";
import { licenseStorageKey } from "./license-record";
import { POLAR_SANDBOX_API } from "./polar-api";
import {
  INSTANCE_ID,
  POLAR_ACTIVATION_ID,
  POLAR_BENEFIT_ID,
  POLAR_KEY,
  POLAR_ORG_ID,
  RAW_KEY,
  activatedBody,
  createFakeFetch,
  createMemoryStorage,
  polarFixtures,
  type MemoryStorage,
  type Responder,
} from "./test-utils";
import type { LicenseClientOptions, LicenseState } from "./types";

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse("2026-09-01T00:00:00Z");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/128.0 Safari/537.36";

function setup(
  responder: Responder,
  opts: { storage?: MemoryStorage; benefitId?: string; baseUrl?: string } = {},
) {
  const storage = opts.storage ?? createMemoryStorage();
  const { fetch, calls } = createFakeFetch(responder);
  const clock = { t: T0 };
  const benefitId = opts.benefitId ?? POLAR_BENEFIT_ID;
  const polar: LicenseClientOptions["polar"] = { organizationId: POLAR_ORG_ID, benefitId };
  if (opts.baseUrl) polar.baseUrl = opts.baseUrl;
  const client = createLicenseClient({
    productName: "arbor",
    provider: "polar",
    allowedProductRefs: [benefitId],
    polar,
    storage,
    fetch,
    now: () => clock.t,
    gracePeriodMs: 14 * DAY,
    revalidateEveryMs: 7 * DAY,
    userAgent: USER_AGENT,
  });
  const changes: LicenseState[] = [];
  client.onChange((state) => changes.push(state));
  return { client, storage, fetch, calls, clock, changes };
}

/** Activates `POLAR_KEY` at T0 and returns the fixture with a switchable responder. */
async function activated() {
  let responder: Responder = () => ({ json: polarFixtures.activateOk() });
  const fx = setup((endpoint, body) => responder(endpoint, body));
  const res = await fx.client.activate(POLAR_KEY);
  expect(res.ok).toBe(true);
  return { ...fx, setResponder: (next: Responder) => (responder = next) };
}

describe("activate() through Polar", () => {
  it("stores a v2 polar record and returns pro with the activation as instance", async () => {
    const fx = setup(() => ({ json: polarFixtures.activateOk() }));
    const res = await fx.client.activate(` ${POLAR_KEY} `);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toMatchObject({
      kind: "pro",
      key: "XXXX-…-B1C2",
      instanceId: POLAR_ACTIVATION_ID,
      email: "pat@example.com",
      lastValidatedAt: T0,
    });
    expect(fx.calls).toHaveLength(1);
    expect(fx.calls[0]?.body).toMatchObject({
      key: POLAR_KEY,
      organization_id: POLAR_ORG_ID,
      label: expect.stringMatching(/^arbor@chrome-[a-z0-9]{6}$/),
    });
    expect(fx.fetch.mock.calls[0]?.[0]).toBe(
      "https://api.polar.sh/v1/customer-portal/license-keys/activate",
    );
    expect(fx.storage.data.get(licenseStorageKey("arbor"))).toMatchObject({
      v: 2,
      kind: "activated",
      provider: "polar",
      key: POLAR_KEY,
      instanceId: POLAR_ACTIVATION_ID,
    });
    expect(JSON.stringify(res.value)).not.toContain(POLAR_KEY);
    await expect(fx.client.isPro()).resolves.toBe(true);
  });

  it("uses the sandbox origin when configured", async () => {
    const fx = setup(() => ({ json: polarFixtures.activateOk() }), { baseUrl: POLAR_SANDBOX_API });
    await fx.client.activate(POLAR_KEY);
    expect(fx.fetch.mock.calls[0]?.[0]).toBe(
      "https://sandbox-api.polar.sh/v1/customer-portal/license-keys/activate",
    );
  });

  it("reports activation limit reached without touching storage", async () => {
    const fx = setup(() => ({ status: 403, json: polarFixtures.activateLimitReached() }));
    const res = await fx.client.activate(POLAR_KEY);
    expect(!res.ok && res.error.code).toBe("activation_limit");
    expect(!res.ok && res.error.detail).toBe("License key activation limit already reached");
    await expect(fx.client.getState()).resolves.toEqual({ kind: "free" });
    expect(fx.changes).toHaveLength(0);
  });

  it("reports revoked and expired keys", async () => {
    const revoked = setup(() => ({ status: 403, json: polarFixtures.activateRevoked() }));
    expect((await revoked.client.activate(POLAR_KEY)).ok).toBe(false);
    const res = await revoked.client.activate(POLAR_KEY);
    expect(!res.ok && res.error.code).toBe("disabled");

    const expired = setup(() => ({ status: 403, json: polarFixtures.activateExpired() }));
    const res2 = await expired.client.activate(POLAR_KEY);
    expect(!res2.ok && res2.error.code).toBe("expired");
  });

  it("reports an unknown key", async () => {
    const fx = setup(() => ({ status: 404, json: polarFixtures.notFound() }));
    const res = await fx.client.activate("ARBOR-NOPE-NOPE-NOPE-NOPE");
    expect(!res.ok && res.error.code).toBe("invalid_key");
    await expect(fx.client.getState()).resolves.toEqual({ kind: "free" });
  });

  it("rejects a key for another benefit and releases the seat", async () => {
    const fixture = polarFixtures.activateOk();
    fixture.license_key.benefit_id = "e1e1e1e1-0000-4000-8000-000000000000";
    const fx = setup((endpoint) => (endpoint === "activate" ? { json: fixture } : { status: 204 }));
    const res = await fx.client.activate(POLAR_KEY);
    expect(!res.ok && res.error.code).toBe("wrong_product");
    expect(fx.calls.map((c) => c.endpoint)).toEqual(["activate", "deactivate"]);
    expect(fx.calls[1]?.body).toEqual({
      key: POLAR_KEY,
      organization_id: POLAR_ORG_ID,
      activation_id: POLAR_ACTIVATION_ID,
    });
    await expect(fx.client.getState()).resolves.toEqual({ kind: "free" });
  });

  it("surfaces a misconfigured benefit as bad_response so nothing is demoted", async () => {
    const fx = setup(() => ({ status: 403, json: polarFixtures.activateNoActivations() }));
    const res = await fx.client.activate(POLAR_KEY);
    expect(!res.ok && res.error.code).toBe("bad_response");
  });

  it("treats 429 as transient", async () => {
    const fx = setup(() => ({
      status: 429,
      json: polarFixtures.rateLimited(),
      headers: { "Retry-After": "60" },
    }));
    const res = await fx.client.activate(POLAR_KEY);
    expect(!res.ok && res.error.code).toBe("network");
    await expect(fx.client.getState()).resolves.toEqual({ kind: "free" });
  });

  it("re-validates the held activation for the same key instead of burning a seat", async () => {
    const fx = await activated();
    fx.setResponder(() => ({ json: polarFixtures.validateOk() }));
    const res = await fx.client.activate(POLAR_KEY);
    expect(res.ok && res.value.kind === "pro" && res.value.instanceId).toBe(POLAR_ACTIVATION_ID);
    expect(fx.calls.map((c) => c.endpoint)).toEqual(["activate", "validate"]);
    expect(fx.calls[1]?.body).toEqual({
      key: POLAR_KEY,
      organization_id: POLAR_ORG_ID,
      activation_id: POLAR_ACTIVATION_ID,
      benefit_id: POLAR_BENEFIT_ID,
    });
  });

  it("falls back to a fresh activation when the activation was deactivated in the portal", async () => {
    const fx = await activated();
    const fresh = polarFixtures.activateOk();
    fresh.id = "11111111-2222-4333-8444-555555555555";
    fx.setResponder((endpoint) =>
      endpoint === "validate" ? { status: 404, json: polarFixtures.notFound() } : { json: fresh },
    );
    const res = await fx.client.activate(POLAR_KEY);
    expect(res.ok && res.value.kind === "pro" && res.value.instanceId).toBe(fresh.id);
    expect(fx.calls.map((c) => c.endpoint)).toEqual(["activate", "validate", "activate"]);
  });
});

describe("validate() through Polar", () => {
  it("hits the network once revalidateEveryMs has elapsed and stays pro", async () => {
    const fx = await activated();
    fx.setResponder(() => ({ json: polarFixtures.validateOk() }));
    fx.clock.t = T0 + 8 * DAY;
    const state = await fx.client.validate();
    expect(state.kind).toBe("pro");
    expect(state.kind === "pro" && state.lastValidatedAt).toBe(T0 + 8 * DAY);
    expect(fx.calls.at(-1)?.endpoint).toBe("validate");
  });

  it("maps a revoked key to invalid(disabled) and switches Pro off", async () => {
    const fx = await activated();
    fx.setResponder(() => ({ status: 404, json: polarFixtures.validateNoLongerActive() }));
    const state = await fx.client.validate({ force: true });
    expect(state).toEqual({ kind: "invalid", reason: "disabled", key: "XXXX-…-B1C2" });
    await expect(fx.client.isPro()).resolves.toBe(false);
    await expect(fx.client.hasStoredKey()).resolves.toBe(true);
  });

  it("maps an expired key to invalid(expired)", async () => {
    const fx = await activated();
    fx.setResponder(() => ({ status: 404, json: polarFixtures.validateExpired() }));
    expect((await fx.client.validate({ force: true })).kind === "invalid").toBe(true);
    const state = await fx.client.getState();
    expect(state.kind === "invalid" && state.reason).toBe("expired");
  });

  it("maps a benefit mismatch to invalid(wrong_product)", async () => {
    const fx = await activated();
    fx.setResponder(() => ({ status: 404, json: polarFixtures.validateBenefitMismatch() }));
    const state = await fx.client.validate({ force: true });
    expect(state.kind === "invalid" && state.reason).toBe("wrong_product");
  });

  it("maps a deactivated activation to invalid(deactivated)", async () => {
    const fx = await activated();
    fx.setResponder(() => ({ status: 404, json: polarFixtures.notFound() }));
    const state = await fx.client.validate({ force: true });
    expect(state.kind === "invalid" && state.reason).toBe("deactivated");
  });

  it("keeps Pro as grace while offline, then degrades and recovers", async () => {
    const fx = await activated();
    fx.setResponder(() => new TypeError("offline"));
    fx.clock.t = T0 + 8 * DAY;
    const graced = await fx.client.validate();
    expect(graced.kind).toBe("grace");
    expect(graced.kind === "grace" && graced.graceEndsAt).toBe(T0 + 14 * DAY);
    await expect(fx.client.isPro()).resolves.toBe(true);

    fx.clock.t = T0 + 15 * DAY;
    expect(await fx.client.validate()).toEqual({ kind: "free", reason: "grace_expired" });

    fx.setResponder(() => ({ json: polarFixtures.validateOk() }));
    expect((await fx.client.validate({ force: true })).kind).toBe("pro");
  });

  it("treats 429 with Retry-After and 5xx as transient, never as a rejection", async () => {
    const fx = await activated();
    fx.clock.t = T0 + 8 * DAY;
    fx.setResponder(() => ({
      status: 429,
      json: polarFixtures.rateLimited(),
      headers: { "Retry-After": "60" },
    }));
    expect((await fx.client.validate()).kind).toBe("grace");
    fx.setResponder(() => ({ status: 502, json: {} }));
    expect((await fx.client.validate()).kind).toBe("grace");
    await expect(fx.client.isPro()).resolves.toBe(true);
  });

  it("treats a 422 as a bad response, not a rejection", async () => {
    const fx = await activated();
    fx.setResponder(() => ({ status: 422, json: polarFixtures.validationError() }));
    expect((await fx.client.validate({ force: true })).kind).toBe("grace");
    await expect(fx.client.isPro()).resolves.toBe(true);
  });
});

describe("deactivate() through Polar", () => {
  it("reads the empty 204 as success and returns to free", async () => {
    const fx = await activated();
    fx.setResponder(() => ({ status: 204 }));
    expect((await fx.client.deactivate()).ok).toBe(true);
    expect(fx.calls.at(-1)?.body).toEqual({
      key: POLAR_KEY,
      organization_id: POLAR_ORG_ID,
      activation_id: POLAR_ACTIVATION_ID,
    });
    await expect(fx.client.getState()).resolves.toEqual({ kind: "free", reason: "deactivated" });
    expect(fx.storage.data.get(licenseStorageKey("arbor"))).toEqual({
      v: 2,
      kind: "free",
      reason: "deactivated",
    });
  });

  it("treats an activation already gone on the server as success", async () => {
    const fx = await activated();
    fx.setResponder(() => ({ status: 404, json: polarFixtures.notFound() }));
    expect((await fx.client.deactivate()).ok).toBe(true);
    await expect(fx.client.isPro()).resolves.toBe(false);
  });

  it("keeps the licence when the network is down", async () => {
    const fx = await activated();
    fx.setResponder(() => new TypeError("offline"));
    const res = await fx.client.deactivate();
    expect(!res.ok && res.error.code).toBe("network");
    await expect(fx.client.isPro()).resolves.toBe(true);
  });
});

describe("provider switch", () => {
  const V1_RECORD = {
    v: 1,
    kind: "activated",
    key: RAW_KEY,
    instanceId: INSTANCE_ID,
    instanceName: "arbor@chrome-abc123",
    lastValidatedAt: T0,
  };

  it("shows a Lemon Squeezy (v1) record as invalid under the Polar client, without network", async () => {
    const storage = createMemoryStorage({ [licenseStorageKey("arbor")]: V1_RECORD });
    const fx = setup(() => ({ json: polarFixtures.validateOk() }), { storage });
    expect(await fx.client.validate({ force: true })).toEqual({
      kind: "invalid",
      reason: "unknown",
      key: "XXXX-…-4d51",
    });
    expect(fx.calls).toHaveLength(0);
    await expect(fx.client.isPro()).resolves.toBe(false);
    await expect(fx.client.hasStoredKey()).resolves.toBe(true);
  });

  it("re-activates the same key against Polar instead of re-validating the foreign instance", async () => {
    const storage = createMemoryStorage({ [licenseStorageKey("arbor")]: V1_RECORD });
    const fx = setup(() => ({ json: polarFixtures.activateOk() }), { storage });
    const res = await fx.client.activate(RAW_KEY);
    expect(res.ok && res.value.kind).toBe("pro");
    expect(fx.calls.map((c) => c.endpoint)).toEqual(["activate"]);
    expect(storage.data.get(licenseStorageKey("arbor"))).toMatchObject({
      v: 2,
      provider: "polar",
      key: RAW_KEY,
    });
  });

  it("drops a foreign record locally on deactivate without calling the new provider", async () => {
    const storage = createMemoryStorage({ [licenseStorageKey("arbor")]: V1_RECORD });
    const fx = setup(() => ({ status: 204 }), { storage });
    expect((await fx.client.deactivate()).ok).toBe(true);
    expect(fx.calls).toHaveLength(0);
    await expect(fx.client.getState()).resolves.toEqual({ kind: "free" });
    await expect(fx.client.hasStoredKey()).resolves.toBe(false);
  });

  it("the Lemon Squeezy client likewise treats a polar record as invalid", async () => {
    const storage = createMemoryStorage();
    const polar = setup(() => ({ json: polarFixtures.activateOk() }), { storage });
    await polar.client.activate(POLAR_KEY);
    const { fetch, calls } = createFakeFetch(() => ({ json: activatedBody() }));
    const lemon = createLicenseClient({ productName: "arbor", storage, fetch, now: () => T0 });
    expect((await lemon.getState()).kind).toBe("invalid");
    expect(await lemon.validate({ force: true })).toMatchObject({ kind: "invalid" });
    expect(calls).toHaveLength(0);
  });

  it("defaults to Lemon Squeezy and refuses provider polar without its options", () => {
    const storage = createMemoryStorage();
    expect(() => createLicenseClient({ productName: "arbor", storage, provider: "polar" })).toThrow(
      /polar/,
    );
    expect(() => createLicenseClient({ productName: "arbor", storage })).not.toThrow();
  });

  it("accepts Lemon Squeezy variant ids through allowedProductRefs as strings", async () => {
    const { fetch } = createFakeFetch(() => ({ json: activatedBody({}, { variantId: 4242 }) }));
    const ok = createLicenseClient({
      productName: "x",
      storage: createMemoryStorage(),
      fetch,
      allowedProductRefs: ["4242"],
    });
    expect((await ok.activate(RAW_KEY)).ok).toBe(true);
    const wrong = createLicenseClient({
      productName: "y",
      storage: createMemoryStorage(),
      fetch,
      allowedProductRefs: ["1"],
    });
    const res = await wrong.activate(RAW_KEY);
    expect(!res.ok && res.error.code).toBe("wrong_product");
  });
});

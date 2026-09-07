import { describe, expect, it, vi } from "vitest";
import { createLicenseClient, isProState, licenseStorageKey, scheduleRevalidation } from "./client";
import type { AlarmsLike, LicenseState, LicenseStorage } from "./types";
import {
  INSTANCE_ID,
  RAW_KEY,
  VARIANT_ID,
  activatedBody,
  createFakeFetch,
  createMemoryStorage,
  validBody,
  type MemoryStorage,
  type Responder,
} from "./test-utils";

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse("2026-09-01T00:00:00Z");

function setup(responder: Responder, opts: { now?: () => number; storage?: MemoryStorage } = {}) {
  const storage = opts.storage ?? createMemoryStorage();
  const { fetch, calls } = createFakeFetch(responder);
  const clock = { t: T0 };
  const client = createLicenseClient({
    productName: "arbor",
    allowedVariantIds: [VARIANT_ID],
    storage,
    fetch,
    now: opts.now ?? (() => clock.t),
    gracePeriodMs: 14 * DAY,
    revalidateEveryMs: 7 * DAY,
    userAgent: "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/128.0 Safari/537.36",
  });
  const changes: LicenseState[] = [];
  client.onChange((s) => changes.push(s));
  return { client, storage, fetch, calls, clock, changes };
}

/** Activates a licence at T0 and returns the fixture with a switchable responder. */
async function activated() {
  let responder: Responder = () => ({ json: activatedBody() });
  const fx = setup((endpoint, body) => responder(endpoint, body));
  const res = await fx.client.activate(RAW_KEY);
  expect(res.ok).toBe(true);
  return { ...fx, setResponder: (r: Responder) => (responder = r) };
}

describe("activate()", () => {
  it("stores the licence and returns a pro state with a masked key", async () => {
    const fx = setup(() => ({ json: activatedBody() }));
    const res = await fx.client.activate(`  ${RAW_KEY}\n`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.kind).toBe("pro");
    if (res.value.kind !== "pro") return;
    expect(res.value.key).toBe("XXXX-…-4d51");
    expect(res.value.instanceId).toBe(INSTANCE_ID);
    expect(res.value.email).toBe("pat@example.com");
    expect(res.value.lastValidatedAt).toBe(T0);
    expect(res.value.expiresAt).toBeUndefined();

    expect(fx.calls).toHaveLength(1);
    expect(fx.calls[0]?.endpoint).toBe("activate");
    expect(fx.calls[0]?.body.license_key).toBe(RAW_KEY);
    expect(fx.calls[0]?.body.instance_name).toMatch(/^arbor@chrome-[a-z0-9]{6}$/);
    expect(fx.fetch.mock.calls[0]?.[0]).toBe("https://api.lemonsqueezy.com/v1/licenses/activate");

    // Raw key is stored (needed for validate) but never exposed in state.
    const stored = fx.storage.data.get(licenseStorageKey("arbor")) as { key: string };
    expect(stored.key).toBe(RAW_KEY);
    expect(JSON.stringify(res.value)).not.toContain(RAW_KEY);
    expect(fx.changes.map((c) => c.kind)).toEqual(["pro"]);
    await expect(fx.client.isPro()).resolves.toBe(true);
  });

  it("parses expires_at into epoch ms", async () => {
    const fx = setup(() => ({
      json: activatedBody({
        license_key: { status: "active", expires_at: "2027-01-01T00:00:00.000000Z" },
      }),
    }));
    const res = await fx.client.activate(RAW_KEY);
    expect(res.ok && res.value.kind === "pro" && res.value.expiresAt).toBe(
      Date.parse("2027-01-01T00:00:00.000Z"),
    );
  });

  it("reports activation limit reached", async () => {
    const fx = setup(() => ({
      status: 400,
      json: {
        activated: false,
        error: "This license key has reached the activation limit.",
        license_key: { status: "active", activation_limit: 1, activation_usage: 1 },
        instance: null,
      },
    }));
    const res = await fx.client.activate(RAW_KEY);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("activation_limit");
    expect(res.error.message).toMatch(/activation limit/i);
    await expect(fx.client.getState()).resolves.toEqual({ kind: "free" });
    expect(fx.changes).toHaveLength(0);
  });

  it("reports an invalid key", async () => {
    const fx = setup(() => ({
      status: 404,
      json: { activated: false, error: "license_key not found." },
    }));
    const res = await fx.client.activate("nope-nope-nope");
    expect(!res.ok && res.error.code).toBe("invalid_key");
    await expect(fx.client.getState()).resolves.toEqual({ kind: "free" });
  });

  it("rejects empty input without touching the network", async () => {
    const fx = setup(() => ({ json: activatedBody() }));
    const res = await fx.client.activate("   ");
    expect(!res.ok && res.error.code).toBe("invalid_key");
    expect(fx.calls).toHaveLength(0);
  });

  it("rejects expired and disabled keys at activation time", async () => {
    for (const status of ["expired", "disabled"] as const) {
      const fx = setup(() => ({
        status: 400,
        json: {
          activated: false,
          error: `This license key is ${status}.`,
          license_key: { status },
        },
      }));
      const res = await fx.client.activate(RAW_KEY);
      expect(!res.ok && res.error.code).toBe(status);
    }
  });

  it("rejects a key for the wrong variant and releases the seat", async () => {
    const fx = setup((endpoint) =>
      endpoint === "activate"
        ? { json: activatedBody({ meta: { variant_id: 999 } }) }
        : { json: { deactivated: true } },
    );
    const res = await fx.client.activate(RAW_KEY);
    expect(!res.ok && res.error.code).toBe("wrong_product");
    expect(fx.calls.map((c) => c.endpoint)).toEqual(["activate", "deactivate"]);
    expect(fx.calls[1]?.body.instance_id).toBe(INSTANCE_ID);
    await expect(fx.client.getState()).resolves.toEqual({ kind: "free" });
  });

  it("does not disturb an existing licence when a second activation fails", async () => {
    const fx = await activated();
    fx.setResponder(() => ({ status: 404, json: { activated: false, error: "not found" } }));
    const res = await fx.client.activate("another-key-0000");
    expect(res.ok).toBe(false);
    await expect(fx.client.isPro()).resolves.toBe(true);
  });

  it("surfaces network failures", async () => {
    const fx = setup(() => new TypeError("Failed to fetch"));
    const res = await fx.client.activate(RAW_KEY);
    expect(!res.ok && res.error.code).toBe("network");
  });

  it("surfaces malformed responses", async () => {
    const fx = setup(() => ({ json: { activated: "yes" } }));
    const res = await fx.client.activate(RAW_KEY);
    expect(!res.ok && res.error.code).toBe("bad_response");
  });
});

describe("validate()", () => {
  it("is skipped while the cached state is recent", async () => {
    const fx = await activated();
    fx.clock.t = T0 + 6 * DAY;
    const state = await fx.client.validate();
    expect(state.kind).toBe("pro");
    expect(fx.calls.map((c) => c.endpoint)).toEqual(["activate"]);
  });

  it("hits the network once revalidateEveryMs has elapsed", async () => {
    const fx = await activated();
    fx.setResponder(() => ({ json: validBody() }));
    fx.clock.t = T0 + 8 * DAY;
    const state = await fx.client.validate();
    expect(state.kind).toBe("pro");
    if (state.kind !== "pro") return;
    expect(state.lastValidatedAt).toBe(T0 + 8 * DAY);
    expect(fx.calls.at(-1)).toEqual({
      endpoint: "validate",
      body: { license_key: RAW_KEY, instance_id: INSTANCE_ID },
    });
  });

  it("can be forced even when recent", async () => {
    const fx = await activated();
    fx.setResponder(() => ({ json: validBody() }));
    fx.clock.t = T0 + 1000;
    await fx.client.validate({ force: true });
    expect(fx.calls.map((c) => c.endpoint)).toEqual(["activate", "validate"]);
  });

  it("maps expired and disabled statuses to invalid", async () => {
    for (const status of ["expired", "disabled"] as const) {
      const fx = await activated();
      fx.setResponder(() => ({
        status: 400,
        json: validBody({ valid: false, error: `license is ${status}`, license_key: { status } }),
      }));
      const state = await fx.client.validate({ force: true });
      expect(state).toEqual({ kind: "invalid", reason: status, key: "XXXX-…-4d51" });
      await expect(fx.client.isPro()).resolves.toBe(false);
      await expect(fx.client.hasStoredKey()).resolves.toBe(true);
    }
  });

  it("maps a variant change to invalid(wrong_product)", async () => {
    const fx = await activated();
    fx.setResponder(() => ({ json: validBody({ meta: { variant_id: 1 } }) }));
    const state = await fx.client.validate({ force: true });
    expect(state.kind === "invalid" && state.reason).toBe("wrong_product");
  });

  it("maps a deleted key / deactivated instance to invalid", async () => {
    const fx = await activated();
    fx.setResponder(() => ({
      status: 404,
      json: { valid: false, error: "license_key not found." },
    }));
    expect((await fx.client.validate({ force: true })).kind).toBe("invalid");
  });

  it("keeps pro behaviour as 'grace' when the network fails inside the grace period", async () => {
    const fx = await activated();
    fx.setResponder(() => new TypeError("offline"));
    fx.clock.t = T0 + 8 * DAY;
    const state = await fx.client.validate();
    expect(state.kind).toBe("grace");
    if (state.kind !== "grace") return;
    expect(state.graceEndsAt).toBe(T0 + 14 * DAY);
    expect(state.key).toBe("XXXX-…-4d51");
    expect(isProState(state)).toBe(true);
    await expect(fx.client.isPro()).resolves.toBe(true);
    expect(fx.changes.map((c) => c.kind)).toEqual(["pro", "grace"]);
  });

  it("retries on every validate() while in grace and recovers to pro", async () => {
    const fx = await activated();
    fx.setResponder(() => new TypeError("offline"));
    fx.clock.t = T0 + 8 * DAY;
    await fx.client.validate();
    fx.clock.t = T0 + 8 * DAY + 60_000;
    fx.setResponder(() => ({ json: validBody() }));
    const state = await fx.client.validate();
    expect(state.kind).toBe("pro");
    expect(fx.calls.map((c) => c.endpoint)).toEqual(["activate", "validate", "validate"]);
  });

  it("degrades to free with a reason once the grace period has passed", async () => {
    const fx = await activated();
    fx.setResponder(() => new TypeError("offline"));
    fx.clock.t = T0 + 15 * DAY;
    const state = await fx.client.validate();
    expect(state).toEqual({ kind: "free", reason: "grace_expired" });
    await expect(fx.client.isPro()).resolves.toBe(false);
    // The key is still stored so "Restore purchase" can re-validate later.
    await expect(fx.client.hasStoredKey()).resolves.toBe(true);
    fx.setResponder(() => ({ json: validBody() }));
    expect((await fx.client.validate()).kind).toBe("pro");
  });

  it("treats 5xx as a transport failure rather than a rejection", async () => {
    const fx = await activated();
    fx.setResponder(() => ({ status: 503, json: {} }));
    fx.clock.t = T0 + 8 * DAY;
    expect((await fx.client.validate()).kind).toBe("grace");
  });

  it("does nothing for a free profile", async () => {
    const fx = setup(() => ({ json: validBody() }));
    expect(await fx.client.validate({ force: true })).toEqual({ kind: "free" });
    expect(fx.calls).toHaveLength(0);
  });

  it("re-checks an invalid licence only when forced (Restore purchase)", async () => {
    const fx = await activated();
    fx.setResponder(() => ({
      status: 400,
      json: validBody({ valid: false, license_key: { status: "expired" } }),
    }));
    await fx.client.validate({ force: true });
    fx.setResponder(() => ({ json: validBody() }));
    expect((await fx.client.validate()).kind).toBe("invalid");
    expect((await fx.client.validate({ force: true })).kind).toBe("pro");
  });
});

describe("deactivate()", () => {
  it("releases the seat and returns to free", async () => {
    const fx = await activated();
    fx.setResponder(() => ({ json: { deactivated: true } }));
    const res = await fx.client.deactivate();
    expect(res.ok).toBe(true);
    expect(fx.calls.at(-1)).toEqual({
      endpoint: "deactivate",
      body: { license_key: RAW_KEY, instance_id: INSTANCE_ID },
    });
    await expect(fx.client.getState()).resolves.toEqual({ kind: "free", reason: "deactivated" });
    await expect(fx.client.hasStoredKey()).resolves.toBe(false);
    // The raw key is gone from storage; only the "deactivated" marker remains.
    expect(JSON.stringify(fx.storage.data.get(licenseStorageKey("arbor")))).not.toContain(RAW_KEY);
    expect(fx.changes.map((c) => c.kind)).toEqual(["pro", "free"]);
  });

  it("fails with not_activated when nothing is stored", async () => {
    const fx = setup(() => ({ json: { deactivated: true } }));
    const res = await fx.client.deactivate();
    expect(!res.ok && res.error.code).toBe("not_activated");
    expect(fx.calls).toHaveLength(0);
  });

  it("keeps the licence when the network is down", async () => {
    const fx = await activated();
    fx.setResponder(() => new TypeError("offline"));
    const res = await fx.client.deactivate();
    expect(!res.ok && res.error.code).toBe("network");
    await expect(fx.client.isPro()).resolves.toBe(true);
  });

  it("treats 'already gone on the server' as success", async () => {
    const fx = await activated();
    fx.setResponder(() => ({
      status: 404,
      json: { deactivated: false, error: "license_key not found." },
    }));
    expect((await fx.client.deactivate()).ok).toBe(true);
    await expect(fx.client.isPro()).resolves.toBe(false);
  });
});

describe("state and storage", () => {
  it("reads state written by another client sharing the same storage", async () => {
    const fx = await activated();
    const other = createLicenseClient({ productName: "arbor", storage: fx.storage });
    await expect(other.isPro()).resolves.toBe(true);
  });

  it("namespaces storage by productName", async () => {
    const storage = createMemoryStorage();
    const arbor = setup(() => ({ json: activatedBody() }), { storage });
    await arbor.client.activate(RAW_KEY);
    const reroute = createLicenseClient({ productName: "reroute", storage });
    await expect(reroute.isPro()).resolves.toBe(false);
  });

  it("degrades corrupted storage to free instead of throwing", async () => {
    const storage = createMemoryStorage({ [licenseStorageKey("arbor")]: { garbage: true } });
    const client = createLicenseClient({ productName: "arbor", storage });
    await expect(client.getState()).resolves.toEqual({ kind: "free" });
  });

  it("persists the instance suffix so the name is stable per profile", async () => {
    const fx = setup(() => ({ json: activatedBody() }));
    const a = await fx.client.getInstanceName();
    const b = await fx.client.getInstanceName();
    expect(a).toBe(b);
    expect(a).toMatch(/^arbor@chrome-[a-z0-9]{6}$/);
    const fresh = createLicenseClient({ productName: "arbor", storage: createMemoryStorage() });
    expect(await fresh.getInstanceName()).not.toBe(a);
  });

  it("onChange unsubscribes and tolerates throwing listeners", async () => {
    const fx = setup(() => ({ json: activatedBody() }));
    const seen: string[] = [];
    fx.client.onChange(() => {
      throw new Error("boom");
    });
    const off = fx.client.onChange((s) => seen.push(s.kind));
    await fx.client.activate(RAW_KEY);
    off();
    await fx.client.activate(RAW_KEY);
    expect(seen).toEqual(["pro"]);
    expect(fx.changes).toHaveLength(2);
  });

  it("accepts every variant when no allowlist is configured", async () => {
    const { fetch } = createFakeFetch(() => ({ json: activatedBody({ meta: { variant_id: 1 } }) }));
    const client = createLicenseClient({ productName: "x", storage: createMemoryStorage(), fetch });
    expect((await client.activate(RAW_KEY)).ok).toBe(true);
  });
});

describe("scheduleRevalidation()", () => {
  function fakeAlarms() {
    const listeners = new Set<(alarm: { name: string }) => void>();
    const alarms: AlarmsLike & { fire(name: string): void } = {
      create: vi.fn(),
      clear: vi.fn(),
      onAlarm: {
        addListener: (cb) => void listeners.add(cb),
        removeListener: (cb) => void listeners.delete(cb),
      },
      fire: (name) => listeners.forEach((cb) => cb({ name })),
    };
    return alarms;
  }

  it("registers the alarm and force-validates when it fires", async () => {
    const fx = await activated();
    fx.setResponder(() => ({ json: validBody() }));
    const alarms = fakeAlarms();
    const stop = scheduleRevalidation(alarms, fx.client, {
      validateOnStart: false,
      revalidateEveryMs: 7 * DAY,
    });
    expect(alarms.create).toHaveBeenCalledWith("arbor:license-revalidate", {
      periodInMinutes: 7 * 24 * 60,
      delayInMinutes: 1,
    });
    alarms.fire("something-else");
    alarms.fire("arbor:license-revalidate");
    await vi.waitFor(() =>
      expect(fx.calls.map((c) => c.endpoint)).toEqual(["activate", "validate"]),
    );
    stop();
    alarms.fire("arbor:license-revalidate");
    await new Promise((r) => setTimeout(r, 0));
    expect(fx.calls).toHaveLength(2);
    expect(alarms.clear).toHaveBeenCalledWith("arbor:license-revalidate");
  });

  it("is available as a client method with the client's interval", async () => {
    const fx = await activated();
    const alarms = fakeAlarms();
    fx.client.scheduleRevalidation(alarms, { validateOnStart: false });
    expect(alarms.create).toHaveBeenCalledWith(fx.client.alarmName, {
      periodInMinutes: 7 * 24 * 60,
      delayInMinutes: 1,
    });
  });
});

/* Compile-time checks: the injectable interfaces accept the real Chrome objects. */
type Assert<T extends true> = T;
type _StorageCompatible = Assert<
  chrome.storage.LocalStorageArea extends LicenseStorage ? true : never
>;
type _AlarmsCompatible = Assert<typeof chrome.alarms extends AlarmsLike ? true : never>;

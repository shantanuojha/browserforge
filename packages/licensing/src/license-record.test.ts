import { describe, expect, it } from "vitest";
import {
  activatedRecord,
  deriveLicenseState,
  parseStoredLicense,
  rejectionReason,
  type StoredActivated,
} from "./license-record.js";

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse("2026-09-01T00:00:00Z");
const GRACE = 14 * DAY;

const identity = {
  provider: "lemonsqueezy",
  key: "38b1460a-5104-4067-a91d-77b872934d51",
  instanceId: "i",
  instanceName: "n",
} as const;

function activatedAt(at: number, extra: Partial<StoredActivated> = {}): StoredActivated {
  return { ...activatedRecord(identity, {}, at), ...extra };
}

describe("deriveLicenseState", () => {
  it("is free when nothing is stored", () => {
    expect(deriveLicenseState(undefined, T0, GRACE)).toEqual({ kind: "free" });
  });

  it("is pro while the last validation succeeded, whatever the time", () => {
    expect(deriveLicenseState(activatedAt(T0), T0 + 400 * DAY, GRACE).kind).toBe("pro");
  });

  it("is grace after a failed validation until the grace period ends, then free", () => {
    const stored = activatedAt(T0, { lastFailedAt: T0 + 8 * DAY });
    const graced = deriveLicenseState(stored, T0 + 10 * DAY, GRACE);
    expect(graced).toMatchObject({ kind: "grace", graceEndsAt: T0 + GRACE });
    expect(deriveLicenseState(stored, T0 + GRACE + 1, GRACE)).toEqual({
      kind: "free",
      reason: "grace_expired",
    });
  });

  it("never exposes the raw key", () => {
    const state = deriveLicenseState(activatedAt(T0), T0, GRACE);
    expect(JSON.stringify(state)).not.toContain(identity.key);
    expect(state).toMatchObject({ key: "XXXX-…-4d51" });
  });
});

describe("rejectionReason", () => {
  it("prefers the explicit key status", () => {
    expect(rejectionReason({ license_key: { status: "expired" } })).toBe("expired");
    expect(rejectionReason({ license_key: { status: "disabled" } })).toBe("disabled");
  });

  it("maps the free-form error text otherwise", () => {
    expect(rejectionReason({ error: "license_key not found." })).toBe("not_found");
    expect(rejectionReason({ error: "instance not found" })).toBe("deactivated");
    expect(rejectionReason({ error: "something odd" })).toBe("unknown");
  });

  it("reads Polar's revoked status as disabled", () => {
    expect(rejectionReason({ license_key: { status: "revoked" } })).toBe("disabled");
  });

  it("trusts an adapter's error_code over the error text", () => {
    expect(rejectionReason({ error: "Not found", error_code: "wrong_product" })).toBe(
      "wrong_product",
    );
    expect(rejectionReason({ error: "Not found", error_code: "not_activated" })).toBe(
      "deactivated",
    );
  });
});

describe("parseStoredLicense", () => {
  it("treats unknown shapes as nothing stored", () => {
    expect(parseStoredLicense({ garbage: true })).toBeUndefined();
    expect(parseStoredLicense({ v: 3, kind: "free" })).toBeUndefined();
    expect(parseStoredLicense({ v: 2, kind: "activated", key: "k" })).toBeUndefined();
    expect(parseStoredLicense({ v: 2, kind: "free" })).toEqual({ v: 2, kind: "free" });
  });

  it("reads a v1 record as a Lemon Squeezy v2 record", () => {
    expect(parseStoredLicense({ v: 1, kind: "free", reason: "deactivated" })).toEqual({
      v: 2,
      kind: "free",
      reason: "deactivated",
    });
    const v1 = {
      v: 1,
      kind: "activated",
      key: identity.key,
      instanceId: "i",
      instanceName: "n",
      lastValidatedAt: T0,
      lastFailedAt: T0 + DAY,
      email: "pat@example.com",
    };
    expect(parseStoredLicense(v1)).toEqual({ ...v1, v: 2, provider: "lemonsqueezy" });
    const invalid = { v: 1, kind: "invalid", key: "k", instanceId: "i", instanceName: "n" };
    expect(parseStoredLicense({ ...invalid, reason: "expired", checkedAt: T0 })).toMatchObject({
      v: 2,
      provider: "lemonsqueezy",
      reason: "expired",
    });
  });

  it("keeps the provider written on a v2 record", () => {
    const stored = activatedRecord({ ...identity, provider: "polar" }, {}, T0);
    expect(stored).toMatchObject({ v: 2, provider: "polar" });
    expect(parseStoredLicense(stored)).toEqual(stored);
  });
});

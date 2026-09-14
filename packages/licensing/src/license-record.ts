/**
 * The persisted licence record and the pure rules that turn it into a `LicenseState`.
 * Validated on read so corrupted storage degrades to "free" and never throws.
 */
import { z } from "zod";
import { classifyApiError, parseExpiresAt } from "./api.js";
import type { LicenseResponse } from "./api-schema.js";
import { maskKey } from "./mask.js";
import type { LicenseInvalidReason, LicenseState, ProLicenseInfo } from "./types.js";

const InvalidReasonSchema = z.enum([
  "expired",
  "disabled",
  "wrong_product",
  "not_found",
  "deactivated",
  "unknown",
]);

const StoredActivatedSchema = z.object({
  v: z.literal(1),
  kind: z.literal("activated"),
  key: z.string(),
  instanceId: z.string(),
  instanceName: z.string(),
  lastValidatedAt: z.number(),
  /** Set when the most recent validation attempt failed for transport reasons. */
  lastFailedAt: z.number().optional(),
  expiresAt: z.number().optional(),
  email: z.string().optional(),
});

const StoredInvalidSchema = z.object({
  v: z.literal(1),
  kind: z.literal("invalid"),
  key: z.string(),
  instanceId: z.string(),
  instanceName: z.string(),
  reason: InvalidReasonSchema,
  checkedAt: z.number(),
});

const StoredFreeSchema = z.object({
  v: z.literal(1),
  kind: z.literal("free"),
  reason: z.enum(["grace_expired", "deactivated"]).optional(),
});

export const StoredLicenseSchema = z.discriminatedUnion("kind", [
  StoredActivatedSchema,
  StoredInvalidSchema,
  StoredFreeSchema,
]);

export type StoredActivated = z.infer<typeof StoredActivatedSchema>;
export type StoredInvalid = z.infer<typeof StoredInvalidSchema>;
export type StoredLicense = z.infer<typeof StoredLicenseSchema>;

/** What identifies this browser's activation on the server. */
export interface LicenseIdentity {
  readonly key: string;
  readonly instanceId: string;
  readonly instanceName: string;
}

/** Storage key holding the licence record for a product. */
export function licenseStorageKey(productName: string): string {
  return `${productName}:license`;
}

/** Storage key holding the per-profile random suffix used in `instance_name`. */
export function instanceSuffixStorageKey(productName: string): string {
  return `${productName}:license-instance-suffix`;
}

/** Alarm name registered by `scheduleRevalidation`. */
export function revalidationAlarmName(productName: string): string {
  return `${productName}:license-revalidate`;
}

/** True for the two states in which Pro features should be available. */
export function isProState(state: LicenseState | null | undefined): boolean {
  return state?.kind === "pro" || state?.kind === "grace";
}

/** Parses whatever is in storage; anything unrecognised reads as "nothing stored". */
export function parseStoredLicense(value: unknown): StoredLicense | undefined {
  const parsed = StoredLicenseSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function toProInfo(stored: StoredActivated): ProLicenseInfo {
  const info: { -readonly [K in keyof ProLicenseInfo]: ProLicenseInfo[K] } = {
    key: maskKey(stored.key),
    instanceId: stored.instanceId,
    instanceName: stored.instanceName,
    lastValidatedAt: stored.lastValidatedAt,
  };
  if (stored.expiresAt !== undefined) info.expiresAt = stored.expiresAt;
  if (stored.email !== undefined) info.email = stored.email;
  return info;
}

function deriveActivatedState(
  stored: StoredActivated,
  at: number,
  gracePeriodMs: number,
): LicenseState {
  const info = toProInfo(stored);
  if (stored.lastFailedAt === undefined) return { kind: "pro", ...info };
  const graceEndsAt = stored.lastValidatedAt + gracePeriodMs;
  if (at <= graceEndsAt) return { kind: "grace", graceEndsAt, ...info };
  return { kind: "free", reason: "grace_expired" };
}

/** The user-facing state for a stored record at time `at`. */
export function deriveLicenseState(
  stored: StoredLicense | undefined,
  at: number,
  gracePeriodMs: number,
): LicenseState {
  if (!stored) return { kind: "free" };
  switch (stored.kind) {
    case "free":
      return stored.reason ? { kind: "free", reason: stored.reason } : { kind: "free" };
    case "invalid":
      return { kind: "invalid", reason: stored.reason, key: maskKey(stored.key) };
    case "activated":
      return deriveActivatedState(stored, at, gracePeriodMs);
  }
}

export function activatedRecord(
  identity: LicenseIdentity,
  body: LicenseResponse,
  at: number,
): StoredActivated {
  const record: StoredActivated = {
    v: 1,
    kind: "activated",
    key: identity.key,
    instanceId: identity.instanceId,
    instanceName: identity.instanceName,
    lastValidatedAt: at,
  };
  const expiresAt = parseExpiresAt(body.license_key?.expires_at);
  if (expiresAt !== undefined) record.expiresAt = expiresAt;
  const email = body.meta?.customer_email;
  if (email) record.email = email;
  return record;
}

export function invalidRecord(
  identity: LicenseIdentity,
  reason: LicenseInvalidReason,
  at: number,
): StoredInvalid {
  return {
    v: 1,
    kind: "invalid",
    key: identity.key,
    instanceId: identity.instanceId,
    instanceName: identity.instanceName,
    reason,
    checkedAt: at,
  };
}

const API_ERROR_TO_INVALID_REASON: Partial<Record<string, LicenseInvalidReason>> = {
  expired: "expired",
  disabled: "disabled",
  invalid_key: "not_found",
  not_activated: "deactivated",
};

/** Why a `validate` answer says the stored key is no longer usable. */
export function rejectionReason(body: LicenseResponse): LicenseInvalidReason {
  const status = body.license_key?.status;
  if (status === "expired") return "expired";
  if (status === "disabled") return "disabled";
  return API_ERROR_TO_INVALID_REASON[classifyApiError(body.error, status)] ?? "unknown";
}

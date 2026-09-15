/**
 * The persisted licence record and the pure rules that turn it into a `LicenseState`.
 * Validated on read so corrupted storage degrades to "free" and never throws.
 *
 * Record versions: v1 predates the provider switch and is read as a Lemon Squeezy record; v2 adds
 * `provider` to every record that holds a key. Writes are always v2.
 */
import { z } from "zod";
import { classifyApiError, parseExpiresAt } from "./api.js";
import type { LicenseResponse } from "./api-schema.js";
import { maskKey } from "./mask.js";
import type {
  LicenseInvalidReason,
  LicenseProvider,
  LicenseState,
  ProLicenseInfo,
} from "./types.js";

const InvalidReasonSchema = z.enum([
  "expired",
  "disabled",
  "wrong_product",
  "not_found",
  "deactivated",
  "unknown",
]);

const ProviderSchema = z.enum(["lemonsqueezy", "polar"]);

const ActivatedFields = {
  kind: z.literal("activated"),
  key: z.string(),
  instanceId: z.string(),
  instanceName: z.string(),
  lastValidatedAt: z.number(),
  /** Set when the most recent validation attempt failed for transport reasons. */
  lastFailedAt: z.number().optional(),
  expiresAt: z.number().optional(),
  email: z.string().optional(),
};

const InvalidFields = {
  kind: z.literal("invalid"),
  key: z.string(),
  instanceId: z.string(),
  instanceName: z.string(),
  reason: InvalidReasonSchema,
  checkedAt: z.number(),
};

const FreeFields = {
  kind: z.literal("free"),
  reason: z.enum(["grace_expired", "deactivated"]).optional(),
};

const StoredActivatedSchema = z.object({
  v: z.literal(2),
  provider: ProviderSchema,
  ...ActivatedFields,
});
const StoredInvalidSchema = z.object({
  v: z.literal(2),
  provider: ProviderSchema,
  ...InvalidFields,
});
const StoredFreeSchema = z.object({ v: z.literal(2), ...FreeFields });

export const StoredLicenseSchema = z.discriminatedUnion("kind", [
  StoredActivatedSchema,
  StoredInvalidSchema,
  StoredFreeSchema,
]);

/** The pre-provider layout; every v1 record was written by the Lemon Squeezy client. */
const StoredLicenseV1Schema = z.discriminatedUnion("kind", [
  z.object({ v: z.literal(1), ...ActivatedFields }),
  z.object({ v: z.literal(1), ...InvalidFields }),
  z.object({ v: z.literal(1), ...FreeFields }),
]);

export type StoredActivated = z.infer<typeof StoredActivatedSchema>;
export type StoredInvalid = z.infer<typeof StoredInvalidSchema>;
export type StoredFree = z.infer<typeof StoredFreeSchema>;
export type StoredLicense = z.infer<typeof StoredLicenseSchema>;

/** What identifies this browser's activation on the server, and which server that is. */
export interface LicenseIdentity {
  readonly provider: LicenseProvider;
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

function migrateV1(value: unknown): StoredLicense | undefined {
  const parsed = StoredLicenseV1Schema.safeParse(value);
  if (!parsed.success) return undefined;
  const record = parsed.data;
  if (record.kind === "free") return { ...record, v: 2 };
  return { ...record, v: 2, provider: "lemonsqueezy" };
}

/** Parses whatever is in storage (v2 or v1); anything unrecognised reads as "nothing stored". */
export function parseStoredLicense(value: unknown): StoredLicense | undefined {
  const parsed = StoredLicenseSchema.safeParse(value);
  return parsed.success ? parsed.data : migrateV1(value);
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

/** A key held by another provider's client: shown as invalid so the user re-activates it here. */
export function foreignRecordState(stored: StoredActivated | StoredInvalid): LicenseState {
  return { kind: "invalid", reason: "unknown", key: maskKey(stored.key) };
}

export function activatedRecord(
  identity: LicenseIdentity,
  body: LicenseResponse,
  at: number,
): StoredActivated {
  const record: StoredActivated = {
    v: 2,
    kind: "activated",
    provider: identity.provider,
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
    v: 2,
    kind: "invalid",
    provider: identity.provider,
    key: identity.key,
    instanceId: identity.instanceId,
    instanceName: identity.instanceName,
    reason,
    checkedAt: at,
  };
}

export function freeRecord(reason?: StoredFree["reason"]): StoredFree {
  return reason ? { v: 2, kind: "free", reason } : { v: 2, kind: "free" };
}

const API_ERROR_TO_INVALID_REASON: Partial<Record<string, LicenseInvalidReason>> = {
  expired: "expired",
  disabled: "disabled",
  wrong_product: "wrong_product",
  invalid_key: "not_found",
  not_activated: "deactivated",
};

/** Why a `validate` answer says the stored key is no longer usable. */
export function rejectionReason(body: LicenseResponse): LicenseInvalidReason {
  const status = body.license_key?.status;
  if (status === "expired") return "expired";
  // Polar says `revoked` (refund, manual pull) where Lemon Squeezy says `disabled`.
  if (status === "disabled" || status === "revoked") return "disabled";
  return API_ERROR_TO_INVALID_REASON[classifyApiError(body)] ?? "unknown";
}

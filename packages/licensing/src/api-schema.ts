/**
 * The normalised licence verdict every `LicenseApi` adapter hands to the client. Field names are
 * inherited from the first provider (Lemon Squeezy answers this shape verbatim); the Polar adapter
 * maps its own responses into it, so `client.ts` and `license-record.ts` never see a provider.
 */
import { z } from "zod";

/** `active` is the only status that grants Pro; `revoked` is Polar's word for a pulled key. */
export type LicenseKeyStatus = "inactive" | "active" | "expired" | "disabled" | "revoked";

export const LICENSE_ERROR_CODES = [
  "invalid_key",
  "activation_limit",
  "wrong_product",
  "expired",
  "disabled",
  "not_activated",
  "network",
  "bad_response",
  "unknown",
] as const;

export type LicenseErrorCode = (typeof LICENSE_ERROR_CODES)[number];

const LicenseKeySchema = z.object({
  id: z.number().optional(),
  status: z.string().optional(),
  key: z.string().optional(),
  activation_limit: z.number().nullable().optional(),
  activation_usage: z.number().optional(),
  created_at: z.string().nullable().optional(),
  expires_at: z.string().nullable().optional(),
});

const InstanceSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  created_at: z.string().nullable().optional(),
});

const MetaSchema = z.object({
  store_id: z.number().optional(),
  product_id: z.number().optional(),
  variant_id: z.number().optional(),
  /**
   * Provider-neutral product reference the key was bought for: Polar's benefit id. Lemon Squeezy
   * leaves it unset and the client falls back to `String(variant_id)`.
   */
  product_ref: z.string().optional(),
  variant_name: z.string().nullable().optional(),
  product_name: z.string().nullable().optional(),
  customer_email: z.string().nullable().optional(),
  customer_name: z.string().nullable().optional(),
});

export const LicenseResponseSchema = z.object({
  activated: z.boolean().optional(),
  valid: z.boolean().optional(),
  deactivated: z.boolean().optional(),
  /** The provider's free-form error string, kept for logs and as `LicenseError.detail`. */
  error: z.string().nullable().optional(),
  /**
   * Set by an adapter that already classified `error`; `classifyApiError` returns it as is.
   * Lemon Squeezy bodies never carry it, so their `error` text goes through the regex table.
   */
  error_code: z.enum(LICENSE_ERROR_CODES).optional(),
  license_key: LicenseKeySchema.nullable().optional(),
  instance: InstanceSchema.nullable().optional(),
  meta: MetaSchema.nullable().optional(),
});

export type LicenseResponse = z.infer<typeof LicenseResponseSchema>;

/** True when the body carries an activate/validate/deactivate verdict or an explicit `error`. */
export function isLicenseVerdict(body: LicenseResponse): boolean {
  return (
    typeof body.activated === "boolean" ||
    typeof body.valid === "boolean" ||
    typeof body.deactivated === "boolean" ||
    typeof body.error === "string"
  );
}

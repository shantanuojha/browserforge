/** Shape of the JSON bodies returned by the Lemon Squeezy licence endpoints. */
import { z } from "zod";

export type LicenseKeyStatus = "inactive" | "active" | "expired" | "disabled";

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
  variant_name: z.string().nullable().optional(),
  product_name: z.string().nullable().optional(),
  customer_email: z.string().nullable().optional(),
  customer_name: z.string().nullable().optional(),
});

export const LicenseResponseSchema = z.object({
  activated: z.boolean().optional(),
  valid: z.boolean().optional(),
  deactivated: z.boolean().optional(),
  error: z.string().nullable().optional(),
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

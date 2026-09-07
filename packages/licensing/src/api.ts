import { z } from "zod";
import type { FetchLike, LicenseError, LicenseErrorCode, LicenseResult } from "./types.js";
import { err, ok } from "@browserforge/shared";

/** The only network origin this package ever talks to. */
export const LEMON_SQUEEZY_API = "https://api.lemonsqueezy.com/v1/licenses";

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

export type LicenseEndpoint = "activate" | "validate" | "deactivate";

export interface ApiCallResult {
  readonly httpStatus: number;
  readonly body: LicenseResponse;
}

const MESSAGES: Record<LicenseErrorCode, string> = {
  invalid_key: "That licence key was not found. Check for typos and try again.",
  activation_limit:
    "This key has reached its activation limit. Deactivate another browser or buy an extra seat.",
  wrong_product: "This key belongs to a different BrowserForge product.",
  expired: "This licence has expired. Renew it to keep using Pro features.",
  disabled: "This licence has been disabled.",
  not_activated: "No licence is activated in this browser.",
  network: "Could not reach the licence server. Check your connection and try again.",
  bad_response: "The licence server returned an unexpected response. Please try again later.",
  unknown: "Something went wrong while checking the licence.",
};

export function licenseError(code: LicenseErrorCode, detail?: string): LicenseError {
  return detail === undefined
    ? { code, message: MESSAGES[code] }
    : { code, message: MESSAGES[code], detail };
}

/** Maps Lemon Squeezy's free-form `error` string and `license_key.status` to a stable code. */
export function classifyApiError(
  error: string | null | undefined,
  status: string | undefined,
): LicenseErrorCode {
  const text = (error ?? "").toLowerCase();
  if (/activation limit/.test(text)) return "activation_limit";
  if (/not found|invalid|does not exist/.test(text) && !/instance/.test(text)) return "invalid_key";
  if (status === "expired" || /expired/.test(text)) return "expired";
  if (status === "disabled" || /disabled/.test(text)) return "disabled";
  if (/instance/.test(text) && /not found|invalid/.test(text)) return "not_activated";
  return "unknown";
}

export function parseExpiresAt(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * POSTs to one of the three licence endpoints. Distinguishes transport/parse failures
 * (`network` / `bad_response`) from application-level answers, which are returned even
 * for HTTP 4xx because Lemon Squeezy uses 400/404 for "activation limit" and "not found".
 */
export async function callLicenseApi(
  fetchImpl: FetchLike,
  baseUrl: string,
  endpoint: LicenseEndpoint,
  body: Record<string, string>,
): Promise<LicenseResult<ApiCallResult>> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/${endpoint}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    return err(licenseError("network", cause instanceof Error ? cause.message : String(cause)));
  }

  if (response.status >= 500) {
    return err(licenseError("network", `HTTP ${response.status}`));
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return err(licenseError("bad_response", `HTTP ${response.status}: non-JSON body`));
  }

  const parsed = LicenseResponseSchema.safeParse(json);
  if (!parsed.success) {
    return err(licenseError("bad_response", parsed.error.message));
  }
  return ok({ httpStatus: response.status, body: parsed.data });
}

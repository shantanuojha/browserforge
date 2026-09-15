/**
 * Lemon Squeezy adapter for the `LicenseApi` port, plus the provider-neutral helpers that read a
 * normalised verdict (`classifyApiError`, `parseExpiresAt`). Lemon Squeezy answers the verdict
 * shape verbatim, so this adapter only validates and forwards.
 */
import { err, ok } from "@browserforge/shared";
import { LicenseResponseSchema, isLicenseVerdict, type LicenseResponse } from "./api-schema.js";
import { licenseError } from "./errors.js";
import { postJson, type HttpAnswer } from "./transport.js";
import type {
  ApiCallResult,
  FetchLike,
  LicenseApi,
  LicenseEndpoint,
  LicenseErrorCode,
  LicenseResult,
} from "./types.js";

export { LicenseResponseSchema, isLicenseVerdict } from "./api-schema.js";
export type { LicenseKeyStatus, LicenseResponse } from "./api-schema.js";
export { licenseError } from "./errors.js";

/** Lemon Squeezy's licence endpoints; the only origin the Lemon Squeezy adapter talks to. */
export const LEMON_SQUEEZY_API = "https://api.lemonsqueezy.com/v1/licenses";

/** The parts of a verdict that say why it was negative. */
export type VerdictError = Pick<LicenseResponse, "error" | "error_code" | "license_key">;

/** The phrases Lemon Squeezy's `error` strings use, in the order they must be tested. */
function classifyLemonSqueezyError(text: string, status: string | undefined): LicenseErrorCode {
  if (/activation limit/.test(text)) return "activation_limit";
  if (/not found|invalid|does not exist/.test(text) && !/instance/.test(text)) return "invalid_key";
  if (status === "expired" || /expired/.test(text)) return "expired";
  if (status === "disabled" || /disabled/.test(text)) return "disabled";
  if (/instance/.test(text) && /not found|invalid/.test(text)) return "not_activated";
  return "unknown";
}

/**
 * Stable code for a negative verdict. An adapter that already classified its answer sets
 * `error_code`; otherwise Lemon Squeezy's free-form `error` text and `license_key.status` are
 * matched against the phrases its API uses.
 */
export function classifyApiError(body: VerdictError): LicenseErrorCode {
  if (body.error_code) return body.error_code;
  return classifyLemonSqueezyError((body.error ?? "").toLowerCase(), body.license_key?.status);
}

export function parseExpiresAt(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Turns a parsed body into an application-level answer. Every field in the schema is optional,
 * so a Laravel validation error (`{ message, errors }`), a proxy page or an empty `{}` also
 * parses; only a body that actually answers the question counts as a verdict, because anything
 * else must not demote a stored licence.
 */
function toVerdict(http: HttpAnswer, endpoint: LicenseEndpoint): LicenseResult<ApiCallResult> {
  const parsed = LicenseResponseSchema.safeParse(http.json);
  if (!parsed.success) return err(licenseError("bad_response", parsed.error.message));
  if (!isLicenseVerdict(parsed.data)) {
    return err(licenseError("bad_response", `HTTP ${http.status}: no ${endpoint} result`));
  }
  return ok({ httpStatus: http.status, body: parsed.data });
}

/**
 * Production adapter over `fetch`. Distinguishes transport/parse failures (`network` /
 * `bad_response`) from application-level answers, which are returned even for HTTP 4xx because
 * Lemon Squeezy uses 400/404 for "activation limit" and "not found".
 */
export function createLicenseApi(fetchImpl: FetchLike, baseUrl = LEMON_SQUEEZY_API): LicenseApi {
  const call = async (
    endpoint: LicenseEndpoint,
    body: Record<string, string>,
  ): Promise<LicenseResult<ApiCallResult>> => {
    const http = await postJson(fetchImpl, `${baseUrl}/${endpoint}`, body);
    return http.ok ? toVerdict(http.value, endpoint) : http;
  };
  return {
    activate: (request) => call("activate", { ...request }),
    validate: (request) => call("validate", { ...request }),
    deactivate: (request) => call("deactivate", { ...request }),
  };
}

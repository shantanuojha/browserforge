import { err, errorMessage, ok } from "@browserforge/shared";
import { LicenseResponseSchema, isLicenseVerdict } from "./api-schema.js";
import type {
  ApiCallResult,
  FetchLike,
  LicenseApi,
  LicenseEndpoint,
  LicenseError,
  LicenseErrorCode,
  LicenseResult,
} from "./types.js";

export { LicenseResponseSchema, isLicenseVerdict } from "./api-schema.js";
export type { LicenseKeyStatus, LicenseResponse } from "./api-schema.js";

/** The only network origin this package ever talks to. */
export const LEMON_SQUEEZY_API = "https://api.lemonsqueezy.com/v1/licenses";

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

interface HttpJson {
  status: number;
  json: unknown;
}

/** Transport layer: POSTs JSON and parses JSON back. Only `network`/`bad_response` can fail here. */
async function postJson(
  fetchImpl: FetchLike,
  url: string,
  body: Record<string, string>,
): Promise<LicenseResult<HttpJson>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    return err(licenseError("network", errorMessage(cause)));
  }
  // 5xx and 429 (Lemon Squeezy throttles at 60 req/min) say nothing about the licence itself.
  if (response.status >= 500 || response.status === 429) {
    return err(licenseError("network", `HTTP ${response.status}`));
  }
  try {
    return ok({ status: response.status, json: await response.json() });
  } catch {
    return err(licenseError("bad_response", `HTTP ${response.status}: non-JSON body`));
  }
}

/**
 * Turns a parsed body into an application-level answer. Every field in the schema is optional,
 * so a Laravel validation error (`{ message, errors }`), a proxy page or an empty `{}` also
 * parses; only a body that actually answers the question counts as a verdict, because anything
 * else must not demote a stored licence.
 */
function toVerdict(http: HttpJson, endpoint: LicenseEndpoint): LicenseResult<ApiCallResult> {
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

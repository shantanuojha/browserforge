/** The user-facing `LicenseError` values; the only place their wording lives. */
import type { LicenseErrorCode } from "./api-schema.js";
import type { LicenseError } from "./types.js";

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

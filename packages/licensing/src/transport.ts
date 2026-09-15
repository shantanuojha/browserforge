/**
 * HTTP transport shared by the provider adapters: POSTs JSON and hands back the status plus the
 * parsed body. It decides only what is *not* a licence answer (unreachable server, throttling,
 * 5xx, unparsable body); interpreting 4xx bodies is the adapter's job because each provider uses
 * them for real verdicts ("not found", "activation limit").
 */
import { err, errorMessage, ok } from "@browserforge/shared";
import { licenseError } from "./errors.js";
import type { FetchLike, LicenseResult } from "./types.js";

export interface HttpAnswer {
  readonly status: number;
  /** Parsed JSON body; `undefined` for a 204 (Polar's deactivate answers with no body). */
  readonly json: unknown;
}

const JSON_HEADERS = { Accept: "application/json", "Content-Type": "application/json" };

/** 5xx and 429 say nothing about the licence itself: the caller keeps what it knew. */
function isTransient(status: number): boolean {
  return status >= 500 || status === 429;
}

function transientDetail(response: Response): string {
  const retryAfter = response.headers.get("Retry-After");
  return retryAfter
    ? `HTTP ${response.status} (Retry-After: ${retryAfter})`
    : `HTTP ${response.status}`;
}

/** Only `network` (unreachable, throttled, 5xx) and `bad_response` (non-JSON) can fail here. */
export async function postJson(
  fetchImpl: FetchLike,
  url: string,
  body: Record<string, string>,
): Promise<LicenseResult<HttpAnswer>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
  } catch (cause) {
    return err(licenseError("network", errorMessage(cause)));
  }
  if (isTransient(response.status)) {
    return err(licenseError("network", transientDetail(response)));
  }
  if (response.status === 204) return ok({ status: 204, json: undefined });
  try {
    return ok({ status: response.status, json: await response.json() });
  } catch {
    return err(licenseError("bad_response", `HTTP ${response.status}: non-JSON body`));
  }
}

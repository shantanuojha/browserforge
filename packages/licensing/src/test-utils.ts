/**
 * Test doubles for the licensing client, shared by every package that exercises Pro gating.
 * Import from `@browserforge/licensing/testing`; never from production code.
 */
import { vi } from "vitest";
import polarActivateExpired from "./fixtures/polar/activate-expired.json";
import polarActivateLimitReached from "./fixtures/polar/activate-limit-reached.json";
import polarActivateNoActivations from "./fixtures/polar/activate-no-activations.json";
import polarActivateOk from "./fixtures/polar/activate-ok.json";
import polarActivateRevoked from "./fixtures/polar/activate-revoked.json";
import polarNotFound from "./fixtures/polar/not-found.json";
import polarRateLimited from "./fixtures/polar/rate-limited-429.json";
import polarValidateBenefitMismatch from "./fixtures/polar/validate-benefit-mismatch.json";
import polarValidateConditionsMismatch from "./fixtures/polar/validate-conditions-mismatch.json";
import polarValidateExpired from "./fixtures/polar/validate-expired.json";
import polarValidateNoLongerActive from "./fixtures/polar/validate-no-longer-active.json";
import polarValidateOk from "./fixtures/polar/validate-ok.json";
import polarValidationError from "./fixtures/polar/validation-error-422.json";
import type { FetchLike, LicenseStorage } from "./types.js";

export interface MemoryStorage extends LicenseStorage {
  readonly data: Map<string, unknown>;
}

/** In-memory `chrome.storage.local` look-alike; values are cloned on write like the real thing. */
export function createMemoryStorage(initial: Record<string, unknown> = {}): MemoryStorage {
  const data = new Map<string, unknown>(Object.entries(initial));
  const toList = (keys: string | string[]) => (typeof keys === "string" ? [keys] : keys);
  return {
    data,
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const key of toList(keys)) if (data.has(key)) out[key] = data.get(key);
      return out;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
    async remove(keys) {
      for (const key of toList(keys)) data.delete(key);
    },
  };
}

export interface RecordedCall {
  readonly endpoint: string;
  readonly body: Record<string, string>;
}

export interface FakeAnswer {
  status?: number;
  /** JSON body; a 204 answer has none whatever is passed here. */
  json?: unknown;
  /** Extra response headers, e.g. `{ "Retry-After": "60" }` on a 429. */
  headers?: Record<string, string>;
}

export type Responder = (endpoint: string, body: Record<string, string>) => FakeAnswer | Error;

/** Builds an injectable `fetch` that records calls and answers via `responder`. */
export function createFakeFetch(responder: Responder) {
  const calls: RecordedCall[] = [];
  const fetchImpl = vi.fn<FetchLike>(async (input, init) => {
    const endpoint = input.slice(input.lastIndexOf("/") + 1);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
    calls.push({ endpoint, body });
    const answer = responder(endpoint, body);
    if (answer instanceof Error) throw answer;
    const status = answer.status ?? 200;
    // `Response` refuses a body on 204, which is exactly what Polar's deactivate returns.
    const responseBody = status === 204 ? null : JSON.stringify(answer.json ?? {});
    return new Response(responseBody, {
      status,
      headers: { "Content-Type": "application/json", ...answer.headers },
    });
  });
  return { fetch: fetchImpl, calls };
}

export const VARIANT_ID = 4242;
export const RAW_KEY = "38b1460a-5104-4067-a91d-77b872934d51";
export const INSTANCE_ID = "5bd6ff3b-9dd8-4fd2-9d7f-1ccb4a1ca2a1";

export interface LicenseBodyOptions {
  /** `meta.variant_id` in the answer; defaults to `VARIANT_ID`. */
  variantId?: number;
  /** `instance.name` in the answer. */
  instanceName?: string;
}

/** A successful `activate` answer for `RAW_KEY`. */
export function activatedBody(
  overrides: Record<string, unknown> = {},
  options: LicenseBodyOptions = {},
) {
  return {
    activated: true,
    error: null,
    license_key: {
      id: 1,
      status: "active",
      key: RAW_KEY,
      activation_limit: 3,
      activation_usage: 1,
      created_at: "2026-01-01T00:00:00.000000Z",
      expires_at: null,
    },
    instance: {
      id: INSTANCE_ID,
      name: options.instanceName ?? "arbor@chrome-abc123",
      created_at: "2026-01-01",
    },
    meta: {
      store_id: 7,
      product_id: 9,
      variant_id: options.variantId ?? VARIANT_ID,
      customer_email: "pat@example.com",
      customer_name: "Pat",
    },
    ...overrides,
  };
}

/** A successful `validate` answer for `RAW_KEY`. */
export function validBody(
  overrides: Record<string, unknown> = {},
  options: LicenseBodyOptions = {},
) {
  const base = activatedBody({}, options);
  return { ...base, activated: undefined, valid: true, ...overrides };
}

/* ------------------------------------------------------------------------------------------ */
/* Polar fixtures                                                                               */

/*
 * The JSON files under `fixtures/polar/` follow Polar's published OpenAPI schemas and the error
 * phrases in Polar's open-source server:
 *
 * - activate 200 `LicenseKeyActivationRead`, 403 `NotPermitted`, 404 `ResourceNotFound`, 422:
 *   https://polar.sh/docs/api-reference/customer-portal/license-keys/activate
 * - validate 200 `ValidatedLicenseKey`, 404 `ResourceNotFound`:
 *   https://polar.sh/docs/api-reference/customer-portal/license-keys/validate
 * - deactivate 204 (no body), 404 `ResourceNotFound`:
 *   https://polar.sh/docs/api-reference/customer-portal/license-keys/deactivate
 * - `detail` wording (`activate()` / `validate()` in the licence-key service):
 *   https://github.com/polarsource/polar/blob/main/server/polar/license_key/service.py
 * - key statuses `granted | revoked | disabled` (`LicenseKeyStatus`) and the customer portal:
 *   https://polar.sh/docs/features/benefits/license-keys
 * - 429 with `Retry-After` on the unauthenticated endpoints (3 requests/second per IP); the body
 *   is not documented, so `rate-limited-429.json` is a stand-in and the header is what matters:
 *   https://polar.sh/docs/api-reference/introduction
 */

/** Ids used consistently across the Polar fixtures. */
export const POLAR_ORG_ID = polarActivateOk.license_key.organization_id;
export const POLAR_BENEFIT_ID = polarActivateOk.license_key.benefit_id;
export const POLAR_ACTIVATION_ID = polarActivateOk.id;
export const POLAR_KEY = polarActivateOk.license_key.key;

/** The JSON import infers literal types (`expires_at: null`); tests need to set other values. */
type Widen<T> = T extends null
  ? string | null
  : T extends string
    ? string
    : T extends number
      ? number
      : T extends boolean
        ? boolean
        : T extends (infer U)[]
          ? Widen<U>[]
          : { -readonly [K in keyof T]: Widen<T[K]> };

/** Fresh copies so a test that mutates one cannot leak into the next. */
function clone<T>(value: T): Widen<T> {
  return structuredClone(value) as Widen<T>;
}

export const polarFixtures = {
  /** activate 200: a new activation for `POLAR_KEY` on the Arbor benefit. */
  activateOk: () => clone(polarActivateOk),
  /** activate 403: every seat taken. */
  activateLimitReached: () => clone(polarActivateLimitReached),
  /** activate 403: key revoked (refund) or disabled. */
  activateRevoked: () => clone(polarActivateRevoked),
  /** activate 403: `expires_at` passed. */
  activateExpired: () => clone(polarActivateExpired),
  /** activate 403: benefit created without an activation limit (owner misconfiguration). */
  activateNoActivations: () => clone(polarActivateNoActivations),
  /** activate/validate/deactivate 404: unknown key, or unknown / deactivated activation. */
  notFound: () => clone(polarNotFound),
  /** validate 200: key granted, our activation attached. */
  validateOk: () => clone(polarValidateOk),
  /** validate 404: key revoked or disabled. */
  validateNoLongerActive: () => clone(polarValidateNoLongerActive),
  /** validate 404: `expires_at` passed. */
  validateExpired: () => clone(polarValidateExpired),
  /** validate 404: `benefit_id` in the request is another product's. */
  validateBenefitMismatch: () => clone(polarValidateBenefitMismatch),
  /** validate 404: activation conditions differ (we never send any). */
  validateConditionsMismatch: () => clone(polarValidateConditionsMismatch),
  /** 422: FastAPI validation error, `detail` is an array. */
  validationError: () => clone(polarValidationError),
  /** 429 body stand-in; pair with `headers: { "Retry-After": "60" }`. */
  rateLimited: () => clone(polarRateLimited),
} as const;

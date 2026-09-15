/**
 * Polar adapter for the `LicenseApi` port. Talks to Polar's public customer-portal licence-key
 * endpoints (no token; CORS-open, so no host permission) and normalises every answer into the
 * `LicenseResponse` verdict the client already understands. It does not decide what a verdict
 * means for the stored licence; that stays in `client.ts` and `license-record.ts`.
 *
 * Endpoints (https://polar.sh/docs/api-reference/customer-portal/license-keys/activate,
 * .../validate, .../deactivate): `POST {base}/v1/customer-portal/license-keys/{endpoint}` with a
 * JSON body. `organization_id` is required in every call and is public. Success is 200 with the
 * activation / validated key, or 204 with no body for deactivate. Negative verdicts are 403
 * (`NotPermitted`) and 404 (`ResourceNotFound`) with `{ error, detail }`; the `detail` phrases
 * come from Polar's server (server/polar/license_key/service.py) and are matched here.
 */
import { err, ok } from "@browserforge/shared";
import { z } from "zod";
import type { LicenseErrorCode, LicenseKeyStatus, LicenseResponse } from "./api-schema.js";
import { licenseError } from "./errors.js";
import { postJson, type HttpAnswer } from "./transport.js";
import type {
  ApiCallResult,
  FetchLike,
  LicenseApi,
  LicenseEndpoint,
  LicenseResult,
  PolarLicenseApiOptions,
} from "./types.js";

/** Production API origin. */
export const POLAR_API = "https://api.polar.sh";
/** Sandbox API origin (https://polar.sh/docs/integrate/sandbox); separate account and data. */
export const POLAR_SANDBOX_API = "https://sandbox-api.polar.sh";

const LICENSE_KEYS_PATH = "/v1/customer-portal/license-keys";

/** Full URL of a customer-portal licence endpoint under `baseUrl`. */
export function polarLicenseKeysUrl(baseUrl: string, endpoint: LicenseEndpoint): string {
  return `${baseUrl.replace(/\/+$/, "")}${LICENSE_KEYS_PATH}/${endpoint}`;
}

/* ------------------------------------------------------------------------------------------ */
/* Polar response shapes (only the fields this adapter reads; everything else passes through)   */

const PolarCustomerSchema = z.object({
  email: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
});

/** `LicenseKeyRead`: nested under `license_key` on activate, top level on validate. */
const PolarLicenseKeySchema = z.object({
  benefit_id: z.string(),
  status: z.string(),
  expires_at: z.string().nullable().optional(),
  limit_activations: z.number().nullable().optional(),
  customer: PolarCustomerSchema.nullable().optional(),
});

/** `LicenseKeyActivationRead` (activate 200). */
const PolarActivationSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  license_key: PolarLicenseKeySchema,
});

/** `ValidatedLicenseKey` (validate 200). */
const PolarValidatedSchema = PolarLicenseKeySchema.extend({
  activation: z.object({ id: z.string(), label: z.string().optional() }).nullable().optional(),
});

/** `NotPermitted` / `ResourceNotFound` / `BadRequest` bodies. A 422 has an array `detail`. */
const PolarErrorSchema = z.object({ error: z.string(), detail: z.string() });

type PolarLicenseKey = z.infer<typeof PolarLicenseKeySchema>;

/* ------------------------------------------------------------------------------------------ */
/* Normalisation                                                                                */

const STATUS_MAP: Record<string, LicenseKeyStatus> = {
  granted: "active",
  revoked: "revoked",
  disabled: "disabled",
};

/**
 * Polar only answers 200 for a key its server considers active (anything else is a 403/404), so
 * a status this table does not know yet must not read as "inactive" and demote a paying user.
 */
function statusOf(polarStatus: string): LicenseKeyStatus {
  return STATUS_MAP[polarStatus] ?? "active";
}

function toLicenseKey(key: PolarLicenseKey): LicenseResponse["license_key"] {
  return {
    status: statusOf(key.status),
    expires_at: key.expires_at ?? null,
    activation_limit: key.limit_activations ?? null,
  };
}

function toMeta(key: PolarLicenseKey): LicenseResponse["meta"] {
  return { product_ref: key.benefit_id, customer_email: key.customer?.email ?? null };
}

type DetailTable = readonly (readonly [RegExp, LicenseErrorCode])[];

/** `activate` 403 `detail` phrases. */
const ACTIVATE_DETAILS: DetailTable = [
  [/activation limit/i, "activation_limit"],
  [/no longer active/i, "disabled"],
  [/expired/i, "expired"],
];

/** `validate` 404 `detail` phrases; a bare "Not found" means the key or our activation is gone. */
const VALIDATE_DETAILS: DetailTable = [
  [/no longer active/i, "disabled"],
  [/expired/i, "expired"],
  [/does not match given benefit/i, "wrong_product"],
  [/not found/i, "not_activated"],
];

/** The benefit was created without an activation limit: a setup error, never a licence verdict. */
const MISCONFIGURED_BENEFIT = /does not support activations/i;

function classifyDetail(detail: string, table: DetailTable): LicenseErrorCode {
  return table.find(([pattern]) => pattern.test(detail))?.[1] ?? "unknown";
}

type Verdict = "activated" | "valid" | "deactivated";

function rejection(verdict: Verdict, detail: string, code: LicenseErrorCode): LicenseResponse {
  return { [verdict]: false, error: detail, error_code: code };
}

function badResponse(http: HttpAnswer, why?: string): LicenseResult<never> {
  return err(licenseError("bad_response", `HTTP ${http.status}${why ? `: ${why}` : ""}`));
}

/** The `detail` of a Polar error body, or `undefined` when the body is not one. */
function errorDetail(http: HttpAnswer): string | undefined {
  const parsed = PolarErrorSchema.safeParse(http.json);
  return parsed.success ? parsed.data.detail : undefined;
}

type Interpreter = (http: HttpAnswer) => LicenseResult<LicenseResponse>;

const interpretActivate: Interpreter = (http) => {
  if (http.status === 200) {
    const parsed = PolarActivationSchema.safeParse(http.json);
    if (!parsed.success) return badResponse(http, parsed.error.message);
    const activation = parsed.data;
    return ok({
      activated: true,
      error: null,
      license_key: toLicenseKey(activation.license_key),
      instance: { id: activation.id, name: activation.label },
      meta: toMeta(activation.license_key),
    });
  }
  const detail = errorDetail(http);
  if (detail === undefined) return badResponse(http);
  if (http.status === 404) return ok(rejection("activated", detail, "invalid_key"));
  if (MISCONFIGURED_BENEFIT.test(detail)) return err(licenseError("bad_response", detail));
  return ok(rejection("activated", detail, classifyDetail(detail, ACTIVATE_DETAILS)));
};

const interpretValidate: Interpreter = (http) => {
  if (http.status === 200) {
    const parsed = PolarValidatedSchema.safeParse(http.json);
    if (!parsed.success) return badResponse(http, parsed.error.message);
    const key = parsed.data;
    return ok({
      valid: true,
      error: null,
      license_key: toLicenseKey(key),
      instance: key.activation ? { id: key.activation.id, name: key.activation.label } : null,
      meta: toMeta(key),
    });
  }
  const detail = errorDetail(http);
  if (detail === undefined) return badResponse(http);
  const code = http.status === 404 ? classifyDetail(detail, VALIDATE_DETAILS) : "unknown";
  return ok(rejection("valid", detail, code));
};

const interpretDeactivate: Interpreter = (http) => {
  if (http.status >= 200 && http.status < 300) return ok({ deactivated: true, error: null });
  const detail = errorDetail(http);
  if (detail === undefined) return badResponse(http);
  const code = http.status === 404 ? "not_activated" : "unknown";
  return ok(rejection("deactivated", detail, code));
};

/* ------------------------------------------------------------------------------------------ */

/**
 * Production adapter over `fetch`. Transport failures (`network`: unreachable, 429, 5xx;
 * `bad_response`: unparsable or unexpected body, 422) come back as errors; every 403/404 with a
 * Polar error body is a verdict, classified into `error_code` so the client never sees Polar's
 * wording.
 */
export function createPolarLicenseApi(
  fetchImpl: FetchLike,
  options: PolarLicenseApiOptions,
): LicenseApi {
  const baseUrl = options.baseUrl ?? POLAR_API;
  const scope = options.benefitId ? { benefit_id: options.benefitId } : {};

  const call = async (
    endpoint: LicenseEndpoint,
    body: Record<string, string>,
    interpret: Interpreter,
  ): Promise<LicenseResult<ApiCallResult>> => {
    const url = polarLicenseKeysUrl(baseUrl, endpoint);
    const http = await postJson(fetchImpl, url, {
      organization_id: options.organizationId,
      ...body,
    });
    if (!http.ok) return http;
    const verdict = interpret(http.value);
    return verdict.ok ? ok({ httpStatus: http.value.status, body: verdict.value }) : verdict;
  };

  return {
    activate: (request) =>
      call(
        "activate",
        { key: request.license_key, label: request.instance_name },
        interpretActivate,
      ),
    validate: (request) =>
      call(
        "validate",
        { key: request.license_key, activation_id: request.instance_id, ...scope },
        interpretValidate,
      ),
    deactivate: (request) =>
      call(
        "deactivate",
        { key: request.license_key, activation_id: request.instance_id },
        interpretDeactivate,
      ),
  };
}

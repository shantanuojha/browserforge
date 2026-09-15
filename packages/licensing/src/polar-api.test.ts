import { describe, expect, it } from "vitest";
import {
  POLAR_API,
  POLAR_SANDBOX_API,
  createPolarLicenseApi,
  polarLicenseKeysUrl,
} from "./polar-api";
import {
  POLAR_ACTIVATION_ID,
  POLAR_BENEFIT_ID,
  POLAR_KEY,
  POLAR_ORG_ID,
  createFakeFetch,
  polarFixtures,
  type Responder,
} from "./test-utils";
import type { LicenseResult } from "./types";
import type { ApiCallResult } from "./types";

const LICENSE_KEYS = "/v1/customer-portal/license-keys";

function api(responder: Responder, options: { benefitId?: string; baseUrl?: string } = {}) {
  const { fetch, calls } = createFakeFetch(responder);
  const polar = createPolarLicenseApi(fetch, { organizationId: POLAR_ORG_ID, ...options });
  return { polar, fetch, calls };
}

/** Unwraps a successful call or fails the test with the error it carried. */
function verdict(result: LicenseResult<ApiCallResult>) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function failure(result: LicenseResult<ApiCallResult>) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected an error");
  return result.error;
}

describe("URLs", () => {
  it("builds the customer-portal endpoint under either origin", () => {
    expect(polarLicenseKeysUrl(POLAR_API, "activate")).toBe(
      "https://api.polar.sh/v1/customer-portal/license-keys/activate",
    );
    expect(polarLicenseKeysUrl(POLAR_SANDBOX_API, "validate")).toBe(
      "https://sandbox-api.polar.sh/v1/customer-portal/license-keys/validate",
    );
    expect(polarLicenseKeysUrl("https://sandbox-api.polar.sh/", "deactivate")).toBe(
      "https://sandbox-api.polar.sh/v1/customer-portal/license-keys/deactivate",
    );
  });

  it("talks to production by default and to the sandbox when configured", async () => {
    const production = api(() => ({ json: polarFixtures.activateOk() }));
    await production.polar.activate({ license_key: POLAR_KEY, instance_name: "arbor@chrome-x" });
    expect(production.fetch.mock.calls[0]?.[0]).toBe(`${POLAR_API}${LICENSE_KEYS}/activate`);

    const sandbox = api(() => ({ json: polarFixtures.activateOk() }), {
      baseUrl: POLAR_SANDBOX_API,
    });
    await sandbox.polar.activate({ license_key: POLAR_KEY, instance_name: "arbor@chrome-x" });
    expect(sandbox.fetch.mock.calls[0]?.[0]).toBe(`${POLAR_SANDBOX_API}${LICENSE_KEYS}/activate`);
  });
});

describe("activate", () => {
  it("sends key, organization_id and label as JSON", async () => {
    const { polar, calls, fetch } = api(() => ({ json: polarFixtures.activateOk() }));
    await polar.activate({ license_key: POLAR_KEY, instance_name: "arbor@chrome-abc123" });
    expect(calls[0]?.body).toEqual({
      key: POLAR_KEY,
      organization_id: POLAR_ORG_ID,
      label: "arbor@chrome-abc123",
    });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("normalises a 200 into an activated verdict with the activation as instance", async () => {
    const { polar } = api(() => ({ json: polarFixtures.activateOk() }));
    const { httpStatus, body } = verdict(
      await polar.activate({ license_key: POLAR_KEY, instance_name: "arbor@chrome-abc123" }),
    );
    expect(httpStatus).toBe(200);
    expect(body).toEqual({
      activated: true,
      error: null,
      license_key: { status: "active", expires_at: null, activation_limit: 5 },
      instance: { id: POLAR_ACTIVATION_ID, name: "arbor@chrome-abc123" },
      meta: { product_ref: POLAR_BENEFIT_ID, customer_email: "pat@example.com" },
    });
  });

  it("carries expires_at through", async () => {
    const fixture = polarFixtures.activateOk();
    fixture.license_key.expires_at = "2027-01-01T00:00:00.000000Z";
    const { polar } = api(() => ({ json: fixture }));
    const { body } = verdict(await polar.activate({ license_key: POLAR_KEY, instance_name: "n" }));
    expect(body.license_key?.expires_at).toBe("2027-01-01T00:00:00.000000Z");
  });

  it("classifies the 403 phrases", async () => {
    const cases = [
      [polarFixtures.activateLimitReached(), "activation_limit"],
      [polarFixtures.activateRevoked(), "disabled"],
      [polarFixtures.activateExpired(), "expired"],
      [{ error: "NotPermitted", detail: "Something new" }, "unknown"],
    ] as const;
    for (const [json, code] of cases) {
      const { polar } = api(() => ({ status: 403, json }));
      const { body } = verdict(
        await polar.activate({ license_key: POLAR_KEY, instance_name: "n" }),
      );
      expect(body.activated).toBe(false);
      expect(body.error_code).toBe(code);
      expect(body.error).toBe(json.detail);
    }
  });

  it("reports a benefit without activation limit as a bad response, not a rejection", async () => {
    const { polar } = api(() => ({ status: 403, json: polarFixtures.activateNoActivations() }));
    const error = failure(await polar.activate({ license_key: POLAR_KEY, instance_name: "n" }));
    expect(error.code).toBe("bad_response");
    expect(error.detail).toMatch(/does not support activations/);
  });

  it("maps 404 to invalid_key", async () => {
    const { polar } = api(() => ({ status: 404, json: polarFixtures.notFound() }));
    const { body } = verdict(await polar.activate({ license_key: "nope", instance_name: "n" }));
    expect(body).toEqual({ activated: false, error: "Not found", error_code: "invalid_key" });
  });
});

describe("validate", () => {
  it("sends activation_id and, when configured, benefit_id", async () => {
    const scoped = api(() => ({ json: polarFixtures.validateOk() }), {
      benefitId: POLAR_BENEFIT_ID,
    });
    await scoped.polar.validate({ license_key: POLAR_KEY, instance_id: POLAR_ACTIVATION_ID });
    expect(scoped.calls[0]?.body).toEqual({
      key: POLAR_KEY,
      organization_id: POLAR_ORG_ID,
      activation_id: POLAR_ACTIVATION_ID,
      benefit_id: POLAR_BENEFIT_ID,
    });

    const unscoped = api(() => ({ json: polarFixtures.validateOk() }));
    await unscoped.polar.validate({ license_key: POLAR_KEY, instance_id: POLAR_ACTIVATION_ID });
    expect(unscoped.calls[0]?.body).not.toHaveProperty("benefit_id");
  });

  it("normalises a 200 into a valid verdict", async () => {
    const { polar } = api(() => ({ json: polarFixtures.validateOk() }));
    const { body } = verdict(
      await polar.validate({ license_key: POLAR_KEY, instance_id: POLAR_ACTIVATION_ID }),
    );
    expect(body).toEqual({
      valid: true,
      error: null,
      license_key: { status: "active", expires_at: null, activation_limit: 5 },
      instance: { id: POLAR_ACTIVATION_ID, name: "arbor@chrome-abc123" },
      meta: { product_ref: POLAR_BENEFIT_ID, customer_email: "pat@example.com" },
    });
  });

  it("classifies the 404 phrases", async () => {
    const cases = [
      [polarFixtures.validateNoLongerActive(), "disabled"],
      [polarFixtures.validateExpired(), "expired"],
      [polarFixtures.validateBenefitMismatch(), "wrong_product"],
      [polarFixtures.notFound(), "not_activated"],
      [polarFixtures.validateConditionsMismatch(), "unknown"],
    ] as const;
    for (const [json, code] of cases) {
      const { polar } = api(() => ({ status: 404, json }));
      const { body } = verdict(
        await polar.validate({ license_key: POLAR_KEY, instance_id: POLAR_ACTIVATION_ID }),
      );
      expect(body.valid).toBe(false);
      expect(body.error_code).toBe(code);
      expect(body.error).toBe(json.detail);
    }
  });

  it("treats a 400 with a Polar error body as an unknown rejection", async () => {
    const { polar } = api(() => ({
      status: 400,
      json: { error: "BadRequest", detail: "License key only has 0 more usages." },
    }));
    const { body } = verdict(
      await polar.validate({ license_key: POLAR_KEY, instance_id: POLAR_ACTIVATION_ID }),
    );
    expect(body).toMatchObject({ valid: false, error_code: "unknown" });
  });
});

describe("deactivate", () => {
  it("sends activation_id and reads the empty 204 as success", async () => {
    const { polar, calls } = api(() => ({ status: 204 }));
    const { httpStatus, body } = verdict(
      await polar.deactivate({ license_key: POLAR_KEY, instance_id: POLAR_ACTIVATION_ID }),
    );
    expect(calls[0]?.body).toEqual({
      key: POLAR_KEY,
      organization_id: POLAR_ORG_ID,
      activation_id: POLAR_ACTIVATION_ID,
    });
    expect(httpStatus).toBe(204);
    expect(body).toEqual({ deactivated: true, error: null });
  });

  it("maps 404 to not_activated so the client counts it as already gone", async () => {
    const { polar } = api(() => ({ status: 404, json: polarFixtures.notFound() }));
    const { body } = verdict(
      await polar.deactivate({ license_key: POLAR_KEY, instance_id: POLAR_ACTIVATION_ID }),
    );
    expect(body).toEqual({ deactivated: false, error: "Not found", error_code: "not_activated" });
  });
});

describe("transport", () => {
  const request = { license_key: POLAR_KEY, instance_id: POLAR_ACTIVATION_ID };

  it("reports 429 as network with the Retry-After header in the detail", async () => {
    const { polar } = api(() => ({
      status: 429,
      json: polarFixtures.rateLimited(),
      headers: { "Retry-After": "60" },
    }));
    const error = failure(await polar.validate(request));
    expect(error.code).toBe("network");
    expect(error.detail).toBe("HTTP 429 (Retry-After: 60)");
  });

  it("reports 5xx and unreachable servers as network", async () => {
    expect(failure(await api(() => ({ status: 503, json: {} })).polar.validate(request)).code).toBe(
      "network",
    );
    const offline = api(() => new TypeError("Failed to fetch"));
    expect(failure(await offline.polar.validate(request)).code).toBe("network");
  });

  it("reports a 422 validation error as bad_response", async () => {
    const { polar } = api(() => ({ status: 422, json: polarFixtures.validationError() }));
    const error = failure(await polar.validate(request));
    expect(error.code).toBe("bad_response");
    expect(error.detail).toBe("HTTP 422");
  });

  it("reports a 200 body that is not a licence key as bad_response", async () => {
    const { polar } = api(() => ({ json: { message: "hello" } }));
    expect(failure(await polar.validate(request)).code).toBe("bad_response");
    expect(failure(await polar.activate({ license_key: POLAR_KEY, instance_name: "n" })).code).toBe(
      "bad_response",
    );
  });

  it("reports a non-JSON 4xx body as bad_response", async () => {
    const { fetch } = createFakeFetch(() => ({ json: {} }));
    fetch.mockResolvedValueOnce(new Response("<html>nope</html>", { status: 403 }));
    const polar = createPolarLicenseApi(fetch, { organizationId: POLAR_ORG_ID });
    expect(failure(await polar.validate(request)).code).toBe("bad_response");
  });
});

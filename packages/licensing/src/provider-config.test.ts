import { describe, expect, it } from "vitest";
import {
  LEMON_SQUEEZY_ORDERS_URL,
  licensingEnvNames,
  polarPortalUrl,
  readProviderConfig,
} from "./provider-config";
import { POLAR_BENEFIT_ID, POLAR_ORG_ID } from "./test-utils";

const ENV = licensingEnvNames("ARBOR");
const PAGE = "https://arbor.example/#pro";
const CHECKOUT = "https://buy.polar.sh/polar_cl_abc";

const POLAR_IDS = { [ENV.organizationId]: POLAR_ORG_ID, [ENV.benefitId]: POLAR_BENEFIT_ID };
const LEMON_IDS = { [ENV.storeId]: "7", [ENV.variantId]: "4242" };

describe("licensingEnvNames", () => {
  it("suffixes the per-product names and shares the org-wide ones", () => {
    expect(ENV.benefitId).toBe("WXT_POLAR_BENEFIT_ID_ARBOR");
    expect(ENV.variantId).toBe("WXT_LEMONSQUEEZY_VARIANT_ID_ARBOR");
    expect(ENV.polarCheckoutUrl).toBe("WXT_POLAR_CHECKOUT_URL_ARBOR");
    expect(licensingEnvNames("REROUTE").benefitId).toBe("WXT_POLAR_BENEFIT_ID_REROUTE");
    expect(licensingEnvNames("REROUTE").organizationId).toBe(ENV.organizationId);
    expect(ENV.provider).toBe("WXT_LICENSE_PROVIDER");
  });
});

describe("readProviderConfig: provider choice", () => {
  it("defaults to Lemon Squeezy, not configured, with the fallback page as every URL", () => {
    expect(readProviderConfig({}, ENV, PAGE)).toEqual({
      provider: "lemonsqueezy",
      checkoutUrl: PAGE,
      restoreUrl: LEMON_SQUEEZY_ORDERS_URL,
      restoreHint: expect.stringMatching(/Lemon Squeezy/),
    });
  });

  it("infers polar when both Polar ids parse", () => {
    const config = readProviderConfig(POLAR_IDS, ENV, PAGE);
    expect(config.provider).toBe("polar");
    expect(config.settings).toEqual({
      name: "polar",
      organizationId: POLAR_ORG_ID,
      benefitId: POLAR_BENEFIT_ID,
    });
  });

  it("infers lemonsqueezy when only its ids parse", () => {
    const config = readProviderConfig(LEMON_IDS, ENV, PAGE);
    expect(config.provider).toBe("lemonsqueezy");
    expect(config.settings).toEqual({ name: "lemonsqueezy", storeId: 7, variantId: 4242 });
  });

  it("lets an explicit WXT_LICENSE_PROVIDER win when both sets of ids are present", () => {
    const both = { ...POLAR_IDS, ...LEMON_IDS };
    expect(
      readProviderConfig({ ...both, [ENV.provider]: "lemonsqueezy" }, ENV, PAGE),
    ).toMatchObject({ provider: "lemonsqueezy", settings: { name: "lemonsqueezy" } });
    expect(readProviderConfig({ ...both, [ENV.provider]: " Polar " }, ENV, PAGE)).toMatchObject({
      provider: "polar",
      settings: { name: "polar" },
    });
    expect(readProviderConfig(both, ENV, PAGE).provider).toBe("polar");
  });

  it("is not configured when the explicit provider's ids are missing", () => {
    const config = readProviderConfig({ ...LEMON_IDS, [ENV.provider]: "polar" }, ENV, PAGE);
    expect(config.provider).toBe("polar");
    expect(config.settings).toBeUndefined();
  });

  it("ignores an unknown provider value and infers instead", () => {
    expect(readProviderConfig({ ...POLAR_IDS, [ENV.provider]: "stripe" }, ENV, PAGE).provider).toBe(
      "polar",
    );
  });

  it("treats malformed ids as unset", () => {
    expect(
      readProviderConfig({ ...POLAR_IDS, [ENV.benefitId]: "not-a-uuid" }, ENV, PAGE).settings,
    ).toBeUndefined();
    expect(
      readProviderConfig({ ...POLAR_IDS, [ENV.organizationId]: "" }, ENV, PAGE).settings,
    ).toBeUndefined();
    expect(readProviderConfig({ ...LEMON_IDS, [ENV.variantId]: "-1" }, ENV, PAGE).settings).toBe(
      undefined,
    );
  });
});

describe("readProviderConfig: Polar URLs", () => {
  it("uses the checkout link and the customer portal for the org slug", () => {
    const config = readProviderConfig(
      { ...POLAR_IDS, [ENV.polarCheckoutUrl]: CHECKOUT, [ENV.polarOrgSlug]: "browserforge" },
      ENV,
      PAGE,
    );
    expect(config.checkoutUrl).toBe(CHECKOUT);
    expect(config.restoreUrl).toBe("https://polar.sh/browserforge/portal");
    expect(config.restoreHint).toMatch(/Polar customer portal/);
  });

  it("falls back to the product page without a checkout URL or slug", () => {
    const config = readProviderConfig(POLAR_IDS, ENV, PAGE);
    expect(config.checkoutUrl).toBe(PAGE);
    expect(config.restoreUrl).toBe(PAGE);
    expect(
      readProviderConfig({ ...POLAR_IDS, [ENV.polarCheckoutUrl]: "http://insecure" }, ENV, PAGE)
        .checkoutUrl,
    ).toBe(PAGE);
    expect(
      readProviderConfig({ ...POLAR_IDS, [ENV.polarOrgSlug]: "bad slug" }, ENV, PAGE).restoreUrl,
    ).toBe(PAGE);
  });

  it("points at the sandbox API and portal when WXT_POLAR_API_BASE is the sandbox", () => {
    const config = readProviderConfig(
      {
        ...POLAR_IDS,
        [ENV.polarOrgSlug]: "browserforge",
        [ENV.polarApiBase]: "https://sandbox-api.polar.sh",
      },
      ENV,
      PAGE,
    );
    expect(config.settings).toMatchObject({ apiBase: "https://sandbox-api.polar.sh" });
    expect(config.restoreUrl).toBe("https://sandbox.polar.sh/browserforge/portal");
  });

  it("ignores a non-https API base", () => {
    const config = readProviderConfig(
      { ...POLAR_IDS, [ENV.polarApiBase]: "http://localhost:8000" },
      ENV,
      PAGE,
    );
    expect(config.settings).not.toHaveProperty("apiBase");
  });
});

describe("polarPortalUrl", () => {
  it("chooses the portal host from the API base", () => {
    expect(polarPortalUrl("browserforge")).toBe("https://polar.sh/browserforge/portal");
    expect(polarPortalUrl("browserforge", "https://api.polar.sh")).toBe(
      "https://polar.sh/browserforge/portal",
    );
    expect(polarPortalUrl("browserforge", "https://sandbox-api.polar.sh/")).toBe(
      "https://sandbox.polar.sh/browserforge/portal",
    );
    expect(polarPortalUrl("browserforge", "garbage")).toBe("https://polar.sh/browserforge/portal");
  });
});

describe("readProviderConfig: Lemon Squeezy URLs", () => {
  it("uses the checkout URL and the orders page", () => {
    const config = readProviderConfig(
      { ...LEMON_IDS, [ENV.lemonSqueezyCheckoutUrl]: "https://x.lemonsqueezy.com/checkout/buy/1" },
      ENV,
      PAGE,
    );
    expect(config.checkoutUrl).toBe("https://x.lemonsqueezy.com/checkout/buy/1");
    expect(config.restoreUrl).toBe(LEMON_SQUEEZY_ORDERS_URL);
  });
});

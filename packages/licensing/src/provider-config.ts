/**
 * Reads the licence provider and its public ids from build-time env vars (`import.meta.env`).
 * Shared by the extensions' `lib/licensing-config.ts` so the inference rule, the env var names
 * and the provider URLs live once. Pure; malformed values read as unset so a typo in `.env`
 * degrades to "not configured" instead of a broken activation flow.
 */
import {
  readEnum,
  readHttpsUrl,
  readPositiveInteger,
  readSlug,
  readUuid,
} from "@browserforge/shared";
import type { LicenseClientOptions, LicenseProvider } from "./types.js";

export const LICENSE_PROVIDERS: readonly LicenseProvider[] = ["lemonsqueezy", "polar"];

/** Lemon Squeezy's customer page where buyers find their keys again. */
export const LEMON_SQUEEZY_ORDERS_URL = "https://app.lemonsqueezy.com/my-orders";
const POLAR_PORTAL_ORIGIN = "https://polar.sh";
const POLAR_SANDBOX_PORTAL_ORIGIN = "https://sandbox.polar.sh";
const POLAR_SANDBOX_API_HOST = "sandbox-api.polar.sh";

/** Names of the env vars that configure licensing for one product. */
export interface LicensingEnvNames {
  /** `lemonsqueezy` | `polar`. Optional: inferred from the ids present when unset. */
  readonly provider: string;
  readonly storeId: string;
  readonly variantId: string;
  readonly lemonSqueezyCheckoutUrl: string;
  readonly organizationId: string;
  readonly benefitId: string;
  readonly polarCheckoutUrl: string;
  /** Organisation slug for the customer portal link (`polar.sh/<slug>/portal`). */
  readonly polarOrgSlug: string;
  /** API origin override; sandbox builds set `https://sandbox-api.polar.sh`. */
  readonly polarApiBase: string;
}

/** The conventional `WXT_*` names for a product suffix such as `"ARBOR"`. See `.env.example`. */
export function licensingEnvNames(productSuffix: string): LicensingEnvNames {
  return {
    provider: "WXT_LICENSE_PROVIDER",
    storeId: "WXT_LEMONSQUEEZY_STORE_ID",
    variantId: `WXT_LEMONSQUEEZY_VARIANT_ID_${productSuffix}`,
    lemonSqueezyCheckoutUrl: `WXT_LEMONSQUEEZY_CHECKOUT_URL_${productSuffix}`,
    organizationId: "WXT_POLAR_ORGANIZATION_ID",
    benefitId: `WXT_POLAR_BENEFIT_ID_${productSuffix}`,
    polarCheckoutUrl: `WXT_POLAR_CHECKOUT_URL_${productSuffix}`,
    polarOrgSlug: "WXT_POLAR_ORG_SLUG",
    polarApiBase: "WXT_POLAR_API_BASE",
  };
}

/** The public ids the chosen provider's adapter needs; present only when they all parsed. */
export type ProviderSettings =
  | { readonly name: "lemonsqueezy"; readonly storeId: number; readonly variantId: number }
  | {
      readonly name: "polar";
      readonly organizationId: string;
      readonly benefitId: string;
      readonly apiBase?: string;
    };

export interface ProviderConfig {
  /** Explicit env var, else the provider whose ids are present, else Lemon Squeezy. */
  readonly provider: LicenseProvider;
  /** Present when this build can actually activate keys. */
  readonly settings?: ProviderSettings;
  /** Hosted checkout URL, or the fallback page when none is configured. */
  readonly checkoutUrl: string;
  /**
   * Where "Restore purchase" sends a buyer with no key stored in this browser: the provider's
   * customer page. Polar: `polar.sh/<slug>/portal` (sandbox: `sandbox.polar.sh/...`).
   */
  readonly restoreUrl: string;
  /** Hint under the key field in the activation dialog, naming the provider's page. */
  readonly restoreHint: string;
}

type Env = Record<string, unknown>;

function readLemonSqueezySettings(
  env: Env,
  names: LicensingEnvNames,
): ProviderSettings | undefined {
  const storeId = readPositiveInteger(env[names.storeId]);
  const variantId = readPositiveInteger(env[names.variantId]);
  if (storeId === undefined || variantId === undefined) return undefined;
  return { name: "lemonsqueezy", storeId, variantId };
}

function readPolarSettings(env: Env, names: LicensingEnvNames): ProviderSettings | undefined {
  const organizationId = readUuid(env[names.organizationId]);
  const benefitId = readUuid(env[names.benefitId]);
  if (organizationId === undefined || benefitId === undefined) return undefined;
  const apiBase = readHttpsUrl(env[names.polarApiBase]);
  return apiBase === undefined
    ? { name: "polar", organizationId, benefitId }
    : { name: "polar", organizationId, benefitId, apiBase };
}

function chooseProvider(env: Env, names: LicensingEnvNames): LicenseProvider {
  const explicit = readEnum(env[names.provider], LICENSE_PROVIDERS);
  if (explicit) return explicit;
  return readPolarSettings(env, names) ? "polar" : "lemonsqueezy";
}

function isSandboxApi(apiBase: string | undefined): boolean {
  if (!apiBase) return false;
  try {
    return new URL(apiBase).host === POLAR_SANDBOX_API_HOST;
  } catch {
    return false;
  }
}

/** The Polar customer portal for `slug`, on the sandbox host when the API base is the sandbox. */
export function polarPortalUrl(slug: string, apiBase?: string): string {
  const origin = isSandboxApi(apiBase) ? POLAR_SANDBOX_PORTAL_ORIGIN : POLAR_PORTAL_ORIGIN;
  return `${origin}/${slug}/portal`;
}

type Links = Pick<ProviderConfig, "checkoutUrl" | "restoreUrl" | "restoreHint">;

function lemonSqueezyLinks(env: Env, names: LicensingEnvNames, fallbackUrl: string): Links {
  return {
    checkoutUrl: readHttpsUrl(env[names.lemonSqueezyCheckoutUrl]) ?? fallbackUrl,
    restoreUrl: LEMON_SQUEEZY_ORDERS_URL,
    restoreHint: "Paste the key from your purchase email or Lemon Squeezy order page.",
  };
}

function polarLinks(env: Env, names: LicensingEnvNames, fallbackUrl: string): Links {
  const slug = readSlug(env[names.polarOrgSlug]);
  const apiBase = readHttpsUrl(env[names.polarApiBase]);
  return {
    checkoutUrl: readHttpsUrl(env[names.polarCheckoutUrl]) ?? fallbackUrl,
    restoreUrl: slug ? polarPortalUrl(slug, apiBase) : fallbackUrl,
    restoreHint: "Paste the key from your purchase email or the Polar customer portal.",
  };
}

const PROVIDER_READERS: Record<
  LicenseProvider,
  {
    settings: (env: Env, names: LicensingEnvNames) => ProviderSettings | undefined;
    links: (env: Env, names: LicensingEnvNames, fallbackUrl: string) => Links;
  }
> = {
  lemonsqueezy: { settings: readLemonSqueezySettings, links: lemonSqueezyLinks },
  polar: { settings: readPolarSettings, links: polarLinks },
};

/** The `createLicenseClient` options that select the adapter and product for `settings`. */
export function providerClientOptions(
  settings: ProviderSettings,
): Pick<LicenseClientOptions, "provider" | "polar" | "allowedProductRefs"> {
  if (settings.name === "polar") {
    const { organizationId, benefitId, apiBase } = settings;
    return {
      provider: "polar",
      allowedProductRefs: [benefitId],
      polar: apiBase
        ? { organizationId, benefitId, baseUrl: apiBase }
        : { organizationId, benefitId },
    };
  }
  return { provider: "lemonsqueezy", allowedProductRefs: [String(settings.variantId)] };
}

/**
 * Reads the provider choice, its ids and its URLs from `env`. `fallbackUrl` (the product page)
 * stands in for a missing checkout URL and, for Polar, a missing organisation slug.
 */
export function readProviderConfig(
  env: Env,
  names: LicensingEnvNames,
  fallbackUrl: string,
): ProviderConfig {
  const provider = chooseProvider(env, names);
  const readers = PROVIDER_READERS[provider];
  const settings = readers.settings(env, names);
  const config: { -readonly [K in keyof ProviderConfig]: ProviderConfig[K] } = {
    provider,
    ...readers.links(env, names, fallbackUrl),
  };
  if (settings) config.settings = settings;
  return config;
}

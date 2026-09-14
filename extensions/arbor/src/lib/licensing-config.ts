/**
 * Build-time licensing configuration for Arbor Pro, read from WXT env vars. Pure: the client
 * wiring that uses it lives in `adapters/licensing.ts`.
 *
 * The extension keeps working when licensing is not configured (no env vars at build time): no
 * client is created, every Pro gate stays closed and the UI says "opening soon".
 */
import { readHttpsUrl, readPositiveInteger } from "@browserforge/shared";

/** Storage namespace and first half of the Lemon Squeezy `instance_name`. */
export const PRODUCT_NAME = "arbor";
export const PRODUCT_LABEL = "Arbor Pro";
export const PRO_PRICE_TEXT = "Pro \u2014 $15 one-time";
/** Product page; used as the "Buy Pro" target when no hosted checkout URL is configured. */
export const PRO_PAGE_URL = "https://arbor.shantanuojha.com/#pro";

/** Names of the WXT env vars (`import.meta.env.*`) that configure licensing. See `.env.example`. */
export const ENV = {
  storeId: "WXT_LEMONSQUEEZY_STORE_ID",
  variantId: "WXT_LEMONSQUEEZY_VARIANT_ID_ARBOR",
  checkoutUrl: "WXT_LEMONSQUEEZY_CHECKOUT_URL_ARBOR",
} as const;

export interface LicensingConfig {
  readonly productName: typeof PRODUCT_NAME;
  readonly productLabel: string;
  /** Lemon Squeezy store id, when configured. */
  readonly storeId?: number;
  /** Lemon Squeezy variant id of "Arbor Pro"; keys for other variants are rejected. */
  readonly variantId?: number;
  /** Hosted checkout URL, or the product page when none is configured. */
  readonly checkoutUrl: string;
  /** True when both ids are present, i.e. keys can actually be activated in this build. */
  readonly configured: boolean;
}

/**
 * Builds the config from an env object (normally `import.meta.env`). Malformed values count as
 * unset so a typo in `.env` degrades to "not configured" instead of a broken activation flow.
 */
export function readLicensingConfig(env: Record<string, unknown>): LicensingConfig {
  const storeId = readPositiveInteger(env[ENV.storeId]);
  const variantId = readPositiveInteger(env[ENV.variantId]);
  const config: { -readonly [K in keyof LicensingConfig]: LicensingConfig[K] } = {
    productName: PRODUCT_NAME,
    productLabel: PRODUCT_LABEL,
    checkoutUrl: readHttpsUrl(env[ENV.checkoutUrl]) ?? PRO_PAGE_URL,
    configured: storeId !== undefined && variantId !== undefined,
  };
  if (storeId !== undefined) config.storeId = storeId;
  if (variantId !== undefined) config.variantId = variantId;
  return config;
}

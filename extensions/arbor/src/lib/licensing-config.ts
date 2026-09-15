/**
 * Build-time licensing configuration for Arbor Pro, read from WXT env vars. Pure: the client
 * wiring that uses it lives in `adapters/licensing.ts`; the provider rules (which provider, which
 * ids, which URLs) live once in `@browserforge/licensing`.
 *
 * The extension keeps working when licensing is not configured (no ids at build time): no client
 * is created, every Pro gate stays closed and the UI says "opening soon".
 */
import {
  licensingEnvNames,
  readProviderConfig,
  type ProviderConfig,
} from "@browserforge/licensing";

/** Storage namespace and first half of the instance name sent to the licence provider. */
export const PRODUCT_NAME = "arbor";
export const PRODUCT_LABEL = "Arbor Pro";
export const PRO_PRICE_TEXT = "Pro \u2014 $15 one-time";
/** Product page; used as the "Buy Pro" target when no hosted checkout URL is configured. */
export const PRO_PAGE_URL = "https://arbor.shantanuojha.com/#pro";

/** Names of the WXT env vars (`import.meta.env.*`) that configure licensing. See `.env.example`. */
export const ENV = licensingEnvNames("ARBOR");

export interface LicensingConfig extends ProviderConfig {
  readonly productName: typeof PRODUCT_NAME;
  readonly productLabel: string;
  /** True when the provider's ids are present, i.e. keys can be activated in this build. */
  readonly configured: boolean;
}

/**
 * Builds the config from an env object (normally `import.meta.env`). Malformed values count as
 * unset so a typo in `.env` degrades to "not configured" instead of a broken activation flow.
 */
export function readLicensingConfig(env: Record<string, unknown>): LicensingConfig {
  const provider = readProviderConfig(env, ENV, PRO_PAGE_URL);
  return {
    productName: PRODUCT_NAME,
    productLabel: PRODUCT_LABEL,
    ...provider,
    configured: provider.settings !== undefined,
  };
}

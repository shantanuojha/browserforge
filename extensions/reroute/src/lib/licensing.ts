/**
 * Reroute's Lemon Squeezy licensing wiring. Owns the build-time configuration (read from WXT env
 * vars), the single `LicenseClient` per JS context, and small helpers for the UI. The client itself
 * lives in `@browserforge/licensing`; this file only decides *how* Reroute uses it.
 *
 * The extension keeps working when licensing is not configured (no env vars at build time): the
 * client is simply absent, every Pro gate stays closed and the UI says "Licensing not configured".
 */
import { browser } from "wxt/browser";
import {
  configureLicensing,
  createLicenseClient,
  licenseStorageKey,
  type LicenseClient,
  type LicenseClientOptions,
} from "@browserforge/licensing";

/** Storage namespace and first half of the Lemon Squeezy `instance_name`. */
export const PRODUCT_NAME = "reroute";
export const PRODUCT_LABEL = "Reroute Pro";
export const PRO_PRICE_TEXT = "Pro \u2014 $9 one-time";
/** Product page; used as the "Buy Pro" target when no hosted checkout URL is configured. */
export const PRO_PAGE_URL = "https://browserforge.dev/reroute#pro";

/** Names of the WXT env vars (`import.meta.env.*`) that configure licensing. See `.env.example`. */
export const ENV = {
  storeId: "WXT_LEMONSQUEEZY_STORE_ID",
  variantId: "WXT_LEMONSQUEEZY_VARIANT_ID_REROUTE",
  checkoutUrl: "WXT_LEMONSQUEEZY_CHECKOUT_URL_REROUTE",
} as const;

export interface LicensingConfig {
  readonly productName: typeof PRODUCT_NAME;
  readonly productLabel: string;
  /** Lemon Squeezy store id, when configured. */
  readonly storeId?: number;
  /** Lemon Squeezy variant id of "Reroute Pro"; keys for other variants are rejected. */
  readonly variantId?: number;
  /** Hosted checkout URL, or the product page when none is configured. */
  readonly checkoutUrl: string;
  /** True when both ids are present, i.e. keys can actually be activated in this build. */
  readonly configured: boolean;
}

function readId(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return undefined;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function readHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  try {
    return new URL(text).protocol === "https:" ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds the config from an env object (normally `import.meta.env`). Malformed values count as
 * unset so a typo in `.env` degrades to "not configured" instead of a broken activation flow.
 */
export function readLicensingConfig(env: Record<string, unknown>): LicensingConfig {
  const storeId = readId(env[ENV.storeId]);
  const variantId = readId(env[ENV.variantId]);
  const config: {
    -readonly [K in keyof LicensingConfig]: LicensingConfig[K];
  } = {
    productName: PRODUCT_NAME,
    productLabel: PRODUCT_LABEL,
    checkoutUrl: readHttpsUrl(env[ENV.checkoutUrl]) ?? PRO_PAGE_URL,
    configured: storeId !== undefined && variantId !== undefined,
  };
  if (storeId !== undefined) config.storeId = storeId;
  if (variantId !== undefined) config.variantId = variantId;
  return config;
}

/** Configuration baked into this build. */
export const LICENSING: LicensingConfig = readLicensingConfig(
  import.meta.env as Record<string, unknown>,
);

export type ClientOverrides = Omit<
  Partial<LicenseClientOptions>,
  "productName" | "allowedVariantIds"
>;

/**
 * Creates a licence client for `config`, or `undefined` when licensing is not configured.
 * Storage defaults to `browser.storage.local`; tests inject their own storage and fetch.
 */
export function createRerouteLicenseClient(
  config: LicensingConfig,
  overrides: ClientOverrides = {},
): LicenseClient | undefined {
  if (!config.configured || config.variantId === undefined) return undefined;
  return createLicenseClient({
    storage: browser.storage.local,
    ...overrides,
    productName: config.productName,
    allowedVariantIds: [config.variantId],
  });
}

/** `null` = not initialised yet; `undefined` = initialised, licensing not configured. */
let current: LicenseClient | undefined | null = null;

/**
 * Creates (once per JS context) the client used by the background, options page and popup, and
 * registers it with `@browserforge/licensing` so `getEntitlements()` reflects it. Idempotent;
 * calling it again returns the same client.
 */
export function setupLicensing(
  config: LicensingConfig = LICENSING,
  overrides?: ClientOverrides,
): LicenseClient | undefined {
  if (current === null) {
    current = createRerouteLicenseClient(config, overrides);
    configureLicensing(current);
  }
  return current;
}

/** The context's licence client, created on first use. `undefined` when not configured. */
export function getLicenseClient(): LicenseClient | undefined {
  return setupLicensing();
}

/** Drops the singleton so tests can start from a clean slate. */
export function resetLicensingForTests(): void {
  current = null;
  configureLicensing(undefined);
}

/**
 * Calls `cb` whenever the stored licence changes, whether from this context (activate/deactivate
 * in the options page) or another one (background revalidation). Returns an unsubscribe function.
 */
export function onLicenseChange(cb: () => void): () => void {
  const key = licenseStorageKey(PRODUCT_NAME);
  const onStorage = (changes: Record<string, unknown>, area: string) => {
    if (area === "local" && key in changes) cb();
  };
  browser.storage.onChanged.addListener(onStorage);
  const unsubscribeClient = getLicenseClient()?.onChange(() => cb());
  return () => {
    browser.storage.onChanged.removeListener(onStorage);
    unsubscribeClient?.();
  };
}

/** Opens the hosted checkout (or the product page) in a new tab. */
export function openCheckout(): void {
  void browser.tabs.create({ url: LICENSING.checkoutUrl });
}

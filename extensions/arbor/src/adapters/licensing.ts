/**
 * Arbor's licensing wiring: the single `LicenseClient` per JS context, backed by
 * `browser.storage.local`, and the small helpers the UI and background need. The client itself
 * lives in `@browserforge/licensing`; the build-time config (which provider, which ids) in
 * `lib/licensing-config.ts`.
 */
import { browser } from "wxt/browser";
import {
  configureLicensing,
  createLicenseClient,
  getEntitlements,
  licenseStorageKey,
  providerClientOptions,
  type LicenseClient,
  type LicenseClientOptions,
} from "@browserforge/licensing";
import { PRODUCT_NAME, readLicensingConfig, type LicensingConfig } from "../lib/licensing-config";

export {
  ENV,
  PRODUCT_LABEL,
  PRODUCT_NAME,
  PRO_PAGE_URL,
  PRO_PRICE_TEXT,
  readLicensingConfig,
  type LicensingConfig,
} from "../lib/licensing-config";

/** Configuration baked into this build. */
export const LICENSING: LicensingConfig = readLicensingConfig(
  import.meta.env as Record<string, unknown>,
);

export type ClientOverrides = Omit<
  Partial<LicenseClientOptions>,
  "productName" | "provider" | "polar" | "allowedProductRefs" | "allowedVariantIds"
>;

/**
 * Creates a licence client for `config`, or `undefined` when licensing is not configured.
 * Storage defaults to `browser.storage.local`; tests inject their own storage and fetch.
 */
export function createArborLicenseClient(
  config: LicensingConfig,
  overrides: ClientOverrides = {},
): LicenseClient | undefined {
  if (!config.settings) return undefined;
  return createLicenseClient({
    storage: browser.storage.local,
    ...overrides,
    productName: config.productName,
    ...providerClientOptions(config.settings),
  });
}

/** `null` = not initialised yet; `undefined` = initialised, licensing not configured. */
let current: LicenseClient | undefined | null = null;

/**
 * Creates (once per JS context) the client used by the background, options page and side panel,
 * and registers it with `@browserforge/licensing` so `getEntitlements()` reflects it. Idempotent;
 * calling it again returns the same client.
 */
export function setupLicensing(
  config: LicensingConfig = LICENSING,
  overrides?: ClientOverrides,
): LicenseClient | undefined {
  if (current === null) {
    current = createArborLicenseClient(config, overrides);
    configureLicensing(current);
  }
  return current;
}

/**
 * Background only. Keeps the stored licence fresh: a cheap validate() now, a forced one on the
 * periodic alarm. Offline stays Pro for the grace period. Nothing runs when licensing is not
 * configured.
 */
export function startLicenseRevalidation(): void {
  setupLicensing()?.scheduleRevalidation(browser.alarms);
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
 * Single Pro gate used everywhere. Reads the cached licence state through the licence client;
 * resolves to `false` when licensing is not configured in this build or the check fails.
 */
export async function isPro(): Promise<boolean> {
  try {
    const entitlements = await getEntitlements(getLicenseClient());
    return entitlements.pro === true;
  } catch {
    return false;
  }
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

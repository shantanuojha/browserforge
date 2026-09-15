/**
 * @browserforge/licensing — licence-key client shared by paid extensions, with adapters for
 * Lemon Squeezy and Polar. See README.md for the specification. Pure TypeScript; the dialog
 * lives in `@browserforge/ui`.
 */
export type {
  ActivateRequest,
  AlarmInfo,
  AlarmsLike,
  ApiCallResult,
  FetchLike,
  InstanceRequest,
  LicenseApi,
  LicenseClient,
  LicenseClientOptions,
  LicenseEndpoint,
  LicenseError,
  LicenseErrorCode,
  LicenseFreeReason,
  LicenseInvalidReason,
  LicenseProvider,
  LicenseResult,
  LicenseState,
  LicenseStorage,
  PolarLicenseApiOptions,
  ProLicenseInfo,
  ScheduleRevalidationOptions,
  ValidateOptions,
} from "./types.js";
export { DEFAULT_GRACE_PERIOD_MS, createLicenseClient } from "./client.js";
export {
  instanceSuffixStorageKey,
  isProState,
  licenseStorageKey,
  revalidationAlarmName,
} from "./license-record.js";
export { DEFAULT_REVALIDATE_EVERY_MS, scheduleRevalidation } from "./revalidation.js";
export { defineFeatures, type FeatureGate, type FeatureTier } from "./features.js";
export { looksLikeLicenseKey, maskKey, normalizeKey } from "./mask.js";
export { browserFamily, type BrowserFamily } from "./instance.js";
export { LEMON_SQUEEZY_API, createLicenseApi } from "./api.js";
export { licenseError } from "./errors.js";
export {
  POLAR_API,
  POLAR_SANDBOX_API,
  createPolarLicenseApi,
  polarLicenseKeysUrl,
} from "./polar-api.js";
export type { LicenseKeyStatus, LicenseResponse } from "./api-schema.js";
export {
  LEMON_SQUEEZY_ORDERS_URL,
  LICENSE_PROVIDERS,
  licensingEnvNames,
  polarPortalUrl,
  providerClientOptions,
  readProviderConfig,
  type LicensingEnvNames,
  type ProviderConfig,
  type ProviderSettings,
} from "./provider-config.js";

import type { LicenseClient } from "./types.js";

/* ------------------------------------------------------------------------------------------ */
/* Module-level entitlements: one client per JS context, consulted by `getEntitlements()`.     */

export interface Entitlements {
  readonly pro: boolean;
}

export const FREE_ENTITLEMENTS: Readonly<Entitlements> = Object.freeze({ pro: false });

let configuredClient: LicenseClient | undefined;

/**
 * Registers the module-level client consulted by `getEntitlements()` when no client is
 * passed explicitly. Pass `undefined` to reset to the free tier.
 */
export function configureLicensing(client: LicenseClient | undefined): void {
  configuredClient = client;
}

/**
 * Resolves the current entitlements. Uses the given client, else the configured one, else
 * resolves to the free tier. Always returns a fresh object.
 */
export async function getEntitlements(client?: LicenseClient): Promise<Entitlements> {
  const active = client ?? configuredClient;
  if (!active) return { ...FREE_ENTITLEMENTS };
  return { pro: await active.isPro() };
}

/**
 * @browserforge/licensing — Lemon Squeezy licence-key client shared by paid extensions.
 * See README.md for the specification. Pure TypeScript; the dialog lives in `@browserforge/ui`.
 */
export type {
  AlarmsLike,
  FetchLike,
  LicenseClient,
  LicenseClientOptions,
  LicenseError,
  LicenseErrorCode,
  LicenseFreeReason,
  LicenseInvalidReason,
  LicenseResult,
  LicenseState,
  LicenseStorage,
  ProLicenseInfo,
  ScheduleRevalidationOptions,
  ValidateOptions,
} from "./types.js";
export {
  DEFAULT_GRACE_PERIOD_MS,
  DEFAULT_REVALIDATE_EVERY_MS,
  createLicenseClient,
  instanceSuffixStorageKey,
  isProState,
  licenseStorageKey,
  revalidationAlarmName,
  scheduleRevalidation,
} from "./client.js";
export { defineFeatures, type FeatureGate, type FeatureTier } from "./features.js";
export { looksLikeLicenseKey, maskKey, normalizeKey } from "./mask.js";
export { browserFamily, type BrowserFamily } from "./instance.js";
export { LEMON_SQUEEZY_API, licenseError } from "./api.js";

import type { LicenseClient } from "./types.js";

/* ------------------------------------------------------------------------------------------ */
/* Legacy entitlements API kept for extensions that predate the client.                       */

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

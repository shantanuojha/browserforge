import type { Result } from "@browserforge/shared";
import type { LicenseErrorCode, LicenseResponse } from "./api-schema.js";

export type { LicenseErrorCode } from "./api-schema.js";

/** The licence-key providers this package has an adapter for. */
export type LicenseProvider = "lemonsqueezy" | "polar";

/** Why a stored licence is no longer usable. */
export type LicenseInvalidReason =
  "expired" | "disabled" | "wrong_product" | "not_found" | "deactivated" | "unknown";

/** Why the client fell back to the free tier (only present after a degradation). */
export type LicenseFreeReason = "grace_expired" | "deactivated";

export interface ProLicenseInfo {
  /** Masked licence key, safe to show in UI (`XXXX-…-1234`). */
  readonly key: string;
  readonly instanceId: string;
  readonly instanceName: string;
  /** Epoch ms of the last successful `activate`/`validate` round-trip. */
  readonly lastValidatedAt: number;
  /** Epoch ms when the licence expires, if the provider reports one. */
  readonly expiresAt?: number;
  readonly email?: string;
}

export type LicenseState =
  | { readonly kind: "free"; readonly reason?: LicenseFreeReason }
  | ({ readonly kind: "pro" } & ProLicenseInfo)
  | ({ readonly kind: "grace"; readonly graceEndsAt: number } & ProLicenseInfo)
  | {
      readonly kind: "invalid";
      readonly reason: LicenseInvalidReason;
      /** Masked key, when the failure concerns a stored licence. */
      readonly key?: string;
    };

export interface LicenseError {
  readonly code: LicenseErrorCode;
  /** Human-readable, safe to show in UI. */
  readonly message: string;
  /** The provider's raw error string when available (for logs). */
  readonly detail?: string;
}

export type LicenseResult<T> = Result<T, LicenseError>;

/**
 * Minimal storage surface, structurally compatible with `chrome.storage.local`
 * (and `browser.storage.local` from `wxt/browser`).
 */
export interface LicenseStorage {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type LicenseEndpoint = "activate" | "validate" | "deactivate";

export interface ApiCallResult {
  readonly httpStatus: number;
  readonly body: LicenseResponse;
}

export interface ActivateRequest {
  license_key: string;
  instance_name: string;
}

export interface InstanceRequest {
  license_key: string;
  instance_id: string;
}

/**
 * Port to a provider's licence endpoints, in the vocabulary of the first provider (`license_key`,
 * `instance_*`). The client depends on this interface only; `createLicenseApi` (Lemon Squeezy)
 * and `createPolarLicenseApi` (Polar) are the production adapters over `fetch`, tests hand in a
 * fake. Every adapter answers with the normalised `LicenseResponse` verdict.
 */
export interface LicenseApi {
  activate(request: ActivateRequest): Promise<LicenseResult<ApiCallResult>>;
  validate(request: InstanceRequest): Promise<LicenseResult<ApiCallResult>>;
  deactivate(request: InstanceRequest): Promise<LicenseResult<ApiCallResult>>;
}

/** What the Polar adapter needs; all of it is public (it travels in unauthenticated bodies). */
export interface PolarLicenseApiOptions {
  /** Polar organisation id (uuid), required in every customer-portal call. */
  organizationId: string;
  /** Sent on `validate` so Polar itself rejects keys bought for another product. */
  benefitId?: string;
  /** API origin: `POLAR_API` (default) or `POLAR_SANDBOX_API`. */
  baseUrl?: string;
}

export interface LicenseClientOptions {
  /** Storage namespace and first half of the instance name sent to the provider. */
  productName: string;
  /**
   * Which provider this client talks to. Default `"lemonsqueezy"`. A stored record from another
   * provider reads as `invalid` so the user re-activates the same key against this one.
   */
  provider?: LicenseProvider;
  /**
   * Product references the key must have been bought for: Polar benefit ids, or Lemon Squeezy
   * variant ids as strings. Anything else is rejected with `wrong_product`. Empty = accept all.
   */
  allowedProductRefs?: readonly string[];
  /** @deprecated Lemon Squeezy variant ids; same as `allowedProductRefs` with `String(id)`. */
  allowedVariantIds?: readonly number[];
  storage: LicenseStorage;
  /** Licence endpoints. Defaults to the adapter for `provider`; tests inject a fake. */
  api?: LicenseApi;
  /** Transport used by the default `api`. Ignored when `api` is given. */
  fetch?: FetchLike;
  /** Settings for the default Polar adapter. Required when `provider` is `"polar"` and no `api`. */
  polar?: PolarLicenseApiOptions;
  now?: () => number;
  /** Offline grace after the last successful validation. Default 14 days. */
  gracePeriodMs?: number;
  /** How often `validate()` actually hits the network. Default 7 days. */
  revalidateEveryMs?: number;
  /** Overrides `navigator.userAgent` for instance naming (tests). */
  userAgent?: string;
  /** Overrides the Lemon Squeezy API base URL (tests). Production is always api.lemonsqueezy.com. */
  apiBaseUrl?: string;
}

export interface ValidateOptions {
  /** Hit the network even if the cached state is fresh. */
  force?: boolean;
}

/** The parts of a `chrome.alarms.Alarm` that `scheduleRevalidation` inspects. */
export interface AlarmInfo {
  name: string;
  periodInMinutes?: number | undefined;
}

/** Subset of `chrome.alarms` used by `scheduleRevalidation`. */
export interface AlarmsLike {
  create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number }): unknown;
  clear?(name: string): unknown;
  /** Used to avoid re-creating (and thereby rescheduling) an alarm that already exists. */
  get?(name: string): Promise<AlarmInfo | undefined> | AlarmInfo | undefined;
  onAlarm: {
    addListener(cb: (alarm: { name: string }) => void): void;
    removeListener(cb: (alarm: { name: string }) => void): void;
  };
}

export interface ScheduleRevalidationOptions {
  /** Run a cheap `validate()` right away as well as on the alarm. Default true. */
  validateOnStart?: boolean;
}

export interface LicenseClient {
  readonly productName: string;
  /** Alarm name used by `scheduleRevalidation`. */
  readonly alarmName: string;
  activate(key: string): Promise<LicenseResult<LicenseState>>;
  validate(opts?: ValidateOptions): Promise<LicenseState>;
  deactivate(): Promise<LicenseResult<void>>;
  getState(): Promise<LicenseState>;
  isPro(): Promise<boolean>;
  onChange(cb: (state: LicenseState) => void): () => void;
  /** `${productName}@${browserLabel}`; the suffix is created on first use and persisted. */
  getInstanceName(): Promise<string>;
  /** True when a key is stored (even if currently invalid) and can be re-validated. */
  hasStoredKey(): Promise<boolean>;
  scheduleRevalidation(alarms: AlarmsLike, options?: ScheduleRevalidationOptions): () => void;
}

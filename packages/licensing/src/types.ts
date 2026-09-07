import type { Result } from "@browserforge/shared";

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
  /** Epoch ms when the licence expires, if Lemon Squeezy reports one. */
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

export type LicenseErrorCode =
  | "invalid_key"
  | "activation_limit"
  | "wrong_product"
  | "expired"
  | "disabled"
  | "not_activated"
  | "network"
  | "bad_response"
  | "unknown";

export interface LicenseError {
  readonly code: LicenseErrorCode;
  /** Human-readable, safe to show in UI. */
  readonly message: string;
  /** Raw `error` string from Lemon Squeezy when available (for logs). */
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

export interface LicenseClientOptions {
  /** Storage namespace and first half of the Lemon Squeezy `instance_name`. */
  productName: string;
  /** Keys bought for any other variant are rejected with `wrong_product`. Empty = accept all. */
  allowedVariantIds?: readonly number[];
  storage: LicenseStorage;
  fetch?: FetchLike;
  now?: () => number;
  /** Offline grace after the last successful validation. Default 14 days. */
  gracePeriodMs?: number;
  /** How often `validate()` actually hits the network. Default 7 days. */
  revalidateEveryMs?: number;
  /** Overrides `navigator.userAgent` for instance naming (tests). */
  userAgent?: string;
  /** Overrides the API base URL (tests). Production is always api.lemonsqueezy.com. */
  apiBaseUrl?: string;
}

export interface ValidateOptions {
  /** Hit the network even if the cached state is fresh. */
  force?: boolean;
}

/** Subset of `chrome.alarms` used by `scheduleRevalidation`. */
export interface AlarmsLike {
  create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number }): unknown;
  clear?(name: string): unknown;
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

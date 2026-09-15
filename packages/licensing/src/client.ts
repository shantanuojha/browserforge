/**
 * The licence client: activation, cached validation with offline grace, deactivation and
 * change notifications over a `LicenseApi` port. Provider-agnostic; the adapter for the
 * configured provider is chosen in `defaultApi` and every answer arrives as a normalised verdict.
 */
import { err, ok, systemClock, type Clock } from "@browserforge/shared";
import { classifyApiError, createLicenseApi, licenseError, type LicenseResponse } from "./api.js";
import { browserFamily, buildInstanceName } from "./instance.js";
import {
  activatedRecord,
  deriveLicenseState,
  foreignRecordState,
  freeRecord,
  invalidRecord,
  isProState,
  rejectionReason,
  revalidationAlarmName,
  type LicenseIdentity,
  type StoredActivated,
  type StoredInvalid,
  type StoredLicense,
} from "./license-record.js";
import { createLicenseRepository, type LicenseRepository } from "./license-repository.js";
import { normalizeKey } from "./mask.js";
import { createPolarLicenseApi } from "./polar-api.js";
import { DEFAULT_REVALIDATE_EVERY_MS, scheduleRevalidation } from "./revalidation.js";
import type {
  AlarmsLike,
  FetchLike,
  LicenseApi,
  LicenseClient,
  LicenseClientOptions,
  LicenseError,
  LicenseProvider,
  LicenseResult,
  LicenseState,
  ScheduleRevalidationOptions,
  ValidateOptions,
} from "./types.js";

export const DEFAULT_GRACE_PERIOD_MS = 14 * 24 * 3600 * 1000;

type StoredKeyed = StoredActivated | StoredInvalid;

/* ------------------------------------------------------------------------------------------ */
/* Wiring                                                                                       */

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

/** The production adapter for `provider`, unless the caller injected an `api` of its own. */
function defaultApi(options: LicenseClientOptions, provider: LicenseProvider): LicenseApi {
  if (options.api) return options.api;
  const fetchImpl = options.fetch ?? defaultFetch;
  if (provider === "polar") {
    if (!options.polar)
      throw new Error("createLicenseClient: provider 'polar' needs `polar` options");
    return createPolarLicenseApi(fetchImpl, options.polar);
  }
  return createLicenseApi(fetchImpl, options.apiBaseUrl);
}

function allowedProductRefs(options: LicenseClientOptions): ReadonlySet<string> {
  return new Set([
    ...(options.allowedProductRefs ?? []),
    ...(options.allowedVariantIds ?? []).map(String),
  ]);
}

/* ------------------------------------------------------------------------------------------ */
/* Answer interpretation                                                                        */

function activationError(body: LicenseResponse): LicenseError {
  const code = classifyApiError(body);
  return licenseError(code === "not_activated" ? "unknown" : code, body.error ?? undefined);
}

/** "Already gone" on the server is a success from the user's point of view. */
function deactivationSucceeded(body: LicenseResponse, code: string): boolean {
  return body.deactivated === true || code === "invalid_key" || code === "not_activated";
}

/** The product the key was bought for, in whichever vocabulary the adapter used. */
function productRef(meta: LicenseResponse["meta"]): string | undefined {
  if (meta?.product_ref !== undefined) return meta.product_ref;
  return meta?.variant_id === undefined ? undefined : String(meta.variant_id);
}

/* ------------------------------------------------------------------------------------------ */

class ProviderLicenseClient implements LicenseClient {
  readonly productName: string;
  readonly alarmName: string;

  private readonly provider: LicenseProvider;
  private readonly api: LicenseApi;
  private readonly repository: LicenseRepository;
  private readonly now: Clock;
  private readonly gracePeriodMs: number;
  private readonly revalidateEveryMs: number;
  private readonly allowedProducts: ReadonlySet<string>;
  private readonly userAgent: string | undefined;
  private readonly listeners = new Set<(state: LicenseState) => void>();

  constructor(options: LicenseClientOptions) {
    this.productName = options.productName;
    this.alarmName = revalidationAlarmName(options.productName);
    this.provider = options.provider ?? "lemonsqueezy";
    this.api = defaultApi(options, this.provider);
    this.repository = createLicenseRepository(options.storage, options.productName);
    this.now = options.now ?? systemClock;
    this.gracePeriodMs = options.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
    this.revalidateEveryMs = options.revalidateEveryMs ?? DEFAULT_REVALIDATE_EVERY_MS;
    this.allowedProducts = allowedProductRefs(options);
    this.userAgent = options.userAgent;
  }

  async activate(input: string): Promise<LicenseResult<LicenseState>> {
    const key = normalizeKey(input);
    if (key.length === 0) return err(licenseError("invalid_key"));
    const stored = await this.repository.load();
    if (stored && stored.kind !== "free" && stored.key === key && !this.isForeign(stored)) {
      const revalidated = await this.revalidateOwnInstance(stored);
      if (revalidated) return revalidated;
      // The instance is gone or the key changed state: fall through to a fresh activation.
    }
    return this.activateFresh(key);
  }

  async validate(opts: ValidateOptions = {}): Promise<LicenseState> {
    const stored = await this.repository.load();
    if (!stored || stored.kind === "free" || this.isForeign(stored)) return this.derive(stored);
    if (!opts.force && !this.isStale(stored)) return this.derive(stored);
    const res = await this.api.validate({
      license_key: stored.key,
      instance_id: stored.instanceId,
    });
    if (!res.ok) return this.recordTransportFailure(stored);
    return this.commit(this.recordVerdict(stored, res.value.body));
  }

  async deactivate(): Promise<LicenseResult<void>> {
    const stored = await this.repository.load();
    if (!stored || stored.kind === "free") return err(licenseError("not_activated"));
    if (this.isForeign(stored)) {
      // The seat lives with a provider this build no longer talks to; drop the record locally.
      await this.commit(undefined);
      return ok(undefined);
    }
    const res = await this.api.deactivate({
      license_key: stored.key,
      instance_id: stored.instanceId,
    });
    if (!res.ok) return err(res.error);
    const { body } = res.value;
    const code = classifyApiError(body);
    if (!deactivationSucceeded(body, code)) return err(licenseError(code, body.error ?? undefined));
    await this.commit(freeRecord("deactivated"));
    return ok(undefined);
  }

  async getState(): Promise<LicenseState> {
    return this.derive(await this.repository.load());
  }

  async isPro(): Promise<boolean> {
    return isProState(await this.getState());
  }

  onChange(listener: (state: LicenseState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async getInstanceName(): Promise<string> {
    const suffix = await this.repository.instanceSuffix();
    const userAgent = this.userAgent ?? globalThis.navigator?.userAgent;
    return buildInstanceName(this.productName, browserFamily(userAgent), suffix);
  }

  async hasStoredKey(): Promise<boolean> {
    const stored = await this.repository.load();
    return stored !== undefined && stored.kind !== "free";
  }

  scheduleRevalidation(alarms: AlarmsLike, options?: ScheduleRevalidationOptions): () => void {
    return scheduleRevalidation(alarms, this, {
      revalidateEveryMs: this.revalidateEveryMs,
      ...options,
    });
  }

  /* ---- internals ------------------------------------------------------------------------- */

  /** A record written by another provider's client (e.g. v1 records after the Polar switch). */
  private isForeign(stored: StoredKeyed): boolean {
    return stored.provider !== this.provider;
  }

  private derive(stored: StoredLicense | undefined): LicenseState {
    if (stored && stored.kind !== "free" && this.isForeign(stored))
      return foreignRecordState(stored);
    return deriveLicenseState(stored, this.now(), this.gracePeriodMs);
  }

  private productAllowed(meta: LicenseResponse["meta"]): boolean {
    if (this.allowedProducts.size === 0) return true;
    const ref = productRef(meta);
    return ref !== undefined && this.allowedProducts.has(ref);
  }

  /** `valid: true` for an active key of an allowed product. */
  private isValidAnswer(body: LicenseResponse): boolean {
    const status = body.license_key?.status ?? "active";
    return body.valid === true && status === "active" && this.productAllowed(body.meta);
  }

  private notify(state: LicenseState): void {
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // A misbehaving subscriber must not break licence bookkeeping.
      }
    }
  }

  /** Persists `record`, derives the resulting state and tells subscribers. */
  private async commit(record: StoredLicense | undefined): Promise<LicenseState> {
    await this.repository.save(record);
    const state = this.derive(record);
    this.notify(state);
    return state;
  }

  /**
   * Same key as the one already on disk (typical after "grace expired" or a store hiccup):
   * re-validate the instance we hold instead of consuming a second activation seat.
   * Resolves to `null` when the server no longer accepts that instance.
   */
  private async revalidateOwnInstance(
    stored: StoredKeyed,
  ): Promise<LicenseResult<LicenseState> | null> {
    const check = await this.api.validate({
      license_key: stored.key,
      instance_id: stored.instanceId,
    });
    if (!check.ok) return check;
    if (!this.isValidAnswer(check.value.body)) return null;
    return ok(await this.commit(activatedRecord(stored, check.value.body, this.now())));
  }

  private async activateFresh(key: string): Promise<LicenseResult<LicenseState>> {
    const instanceName = await this.getInstanceName();
    const res = await this.api.activate({ license_key: key, instance_name: instanceName });
    if (!res.ok) return res;
    const { body } = res.value;
    if (!body.activated || !body.instance) return err(activationError(body));
    if (!this.productAllowed(body.meta)) {
      // Release the seat we just consumed; the key is for a different product.
      await this.api.deactivate({ license_key: key, instance_id: body.instance.id });
      return err(licenseError("wrong_product"));
    }
    const identity: LicenseIdentity = {
      provider: this.provider,
      key,
      instanceId: body.instance.id,
      instanceName,
    };
    return ok(await this.commit(activatedRecord(identity, body, this.now())));
  }

  /** Whether a non-forced `validate()` should hit the network for this record. */
  private isStale(stored: StoredKeyed): boolean {
    if (stored.kind === "invalid") return false;
    const fresh = this.now() - stored.lastValidatedAt < this.revalidateEveryMs;
    return !(fresh && stored.lastFailedAt === undefined);
  }

  /** Transport failure: keep whatever we knew, but remember that we could not confirm it. */
  private recordTransportFailure(stored: StoredKeyed): Promise<LicenseState> {
    if (stored.kind === "invalid") return Promise.resolve(this.derive(stored));
    return this.commit({ ...stored, lastFailedAt: this.now() });
  }

  private recordVerdict(stored: StoredKeyed, body: LicenseResponse): StoredLicense {
    const at = this.now();
    const status = body.license_key?.status ?? "active";
    if (!body.valid || status !== "active") return invalidRecord(stored, rejectionReason(body), at);
    if (!this.productAllowed(body.meta)) return invalidRecord(stored, "wrong_product", at);
    return activatedRecord(stored, body, at);
  }
}

export function createLicenseClient(options: LicenseClientOptions): LicenseClient {
  return new ProviderLicenseClient(options);
}

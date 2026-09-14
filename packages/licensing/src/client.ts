import { err, ok, systemClock, type Clock } from "@browserforge/shared";
import { classifyApiError, createLicenseApi, licenseError, type LicenseResponse } from "./api.js";
import { browserFamily, buildInstanceName, randomInstanceSuffix } from "./instance.js";
import {
  activatedRecord,
  deriveLicenseState,
  instanceSuffixStorageKey,
  invalidRecord,
  isProState,
  licenseStorageKey,
  parseStoredLicense,
  rejectionReason,
  revalidationAlarmName,
  type LicenseIdentity,
  type StoredActivated,
  type StoredInvalid,
  type StoredLicense,
} from "./license-record.js";
import { normalizeKey } from "./mask.js";
import { DEFAULT_REVALIDATE_EVERY_MS, scheduleRevalidation } from "./revalidation.js";
import type {
  AlarmsLike,
  FetchLike,
  LicenseApi,
  LicenseClient,
  LicenseClientOptions,
  LicenseError,
  LicenseResult,
  LicenseState,
  LicenseStorage,
  ScheduleRevalidationOptions,
  ValidateOptions,
} from "./types.js";

export const DEFAULT_GRACE_PERIOD_MS = 14 * 24 * 3600 * 1000;

type StoredKeyed = StoredActivated | StoredInvalid;

/* ------------------------------------------------------------------------------------------ */
/* Storage boundary                                                                             */

interface LicenseRepository {
  load(): Promise<StoredLicense | undefined>;
  save(record: StoredLicense | undefined): Promise<void>;
  /** Per-profile random suffix for `instance_name`, created and persisted on first use. */
  instanceSuffix(): Promise<string>;
}

// The parameter is deliberately not called `storage`: WXT's vitest plugin auto-imports
// `wxt/utils/storage` for any bare `storage` identifier it finds, even in workspace packages.
function createLicenseRepository(area: LicenseStorage, productName: string): LicenseRepository {
  const licenseKey = licenseStorageKey(productName);
  const suffixKey = instanceSuffixStorageKey(productName);
  return {
    async load() {
      const record = await area.get(licenseKey);
      return parseStoredLicense(record[licenseKey]);
    },
    async save(record) {
      if (record) await area.set({ [licenseKey]: record });
      else await area.remove(licenseKey);
    },
    async instanceSuffix() {
      const existing = (await area.get(suffixKey))[suffixKey];
      if (typeof existing === "string" && existing.length > 0) return existing;
      const suffix = randomInstanceSuffix();
      await area.set({ [suffixKey]: suffix });
      return suffix;
    },
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Answer interpretation                                                                        */

function activationError(body: LicenseResponse): LicenseError {
  const code = classifyApiError(body.error, body.license_key?.status);
  return licenseError(code === "not_activated" ? "unknown" : code, body.error ?? undefined);
}

/** "Already gone" on the server is a success from the user's point of view. */
function deactivationSucceeded(body: LicenseResponse, code: string): boolean {
  return body.deactivated === true || code === "invalid_key" || code === "not_activated";
}

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

/* ------------------------------------------------------------------------------------------ */

class LemonSqueezyLicenseClient implements LicenseClient {
  readonly productName: string;
  readonly alarmName: string;

  private readonly api: LicenseApi;
  private readonly repository: LicenseRepository;
  private readonly now: Clock;
  private readonly gracePeriodMs: number;
  private readonly revalidateEveryMs: number;
  private readonly allowedVariants: ReadonlySet<number>;
  private readonly userAgent: string | undefined;
  private readonly listeners = new Set<(state: LicenseState) => void>();

  constructor(options: LicenseClientOptions) {
    this.productName = options.productName;
    this.alarmName = revalidationAlarmName(options.productName);
    this.api = options.api ?? createLicenseApi(options.fetch ?? defaultFetch, options.apiBaseUrl);
    this.repository = createLicenseRepository(options.storage, options.productName);
    this.now = options.now ?? systemClock;
    this.gracePeriodMs = options.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
    this.revalidateEveryMs = options.revalidateEveryMs ?? DEFAULT_REVALIDATE_EVERY_MS;
    this.allowedVariants = new Set(options.allowedVariantIds ?? []);
    this.userAgent = options.userAgent;
  }

  async activate(input: string): Promise<LicenseResult<LicenseState>> {
    const key = normalizeKey(input);
    if (key.length === 0) return err(licenseError("invalid_key"));
    const stored = await this.repository.load();
    if (stored && stored.kind !== "free" && stored.key === key) {
      const revalidated = await this.revalidateOwnInstance(stored);
      if (revalidated) return revalidated;
      // The instance is gone or the key changed state: fall through to a fresh activation.
    }
    return this.activateFresh(key);
  }

  async validate(opts: ValidateOptions = {}): Promise<LicenseState> {
    const stored = await this.repository.load();
    if (!stored || stored.kind === "free") return this.derive(stored);
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
    const res = await this.api.deactivate({
      license_key: stored.key,
      instance_id: stored.instanceId,
    });
    if (!res.ok) return err(res.error);
    const { body } = res.value;
    const code = classifyApiError(body.error, body.license_key?.status);
    if (!deactivationSucceeded(body, code)) return err(licenseError(code, body.error ?? undefined));
    await this.commit({ v: 1, kind: "free", reason: "deactivated" });
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

  private derive(stored: StoredLicense | undefined): LicenseState {
    return deriveLicenseState(stored, this.now(), this.gracePeriodMs);
  }

  private variantAllowed(meta: LicenseResponse["meta"]): boolean {
    if (this.allowedVariants.size === 0) return true;
    const variantId = meta?.variant_id;
    return variantId !== undefined && this.allowedVariants.has(variantId);
  }

  /** `valid: true` for an active key of an allowed variant. */
  private isValidAnswer(body: LicenseResponse): boolean {
    const status = body.license_key?.status ?? "active";
    return body.valid === true && status === "active" && this.variantAllowed(body.meta);
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
    if (!this.variantAllowed(body.meta)) {
      // Release the seat we just consumed; the key is for a different product.
      await this.api.deactivate({ license_key: key, instance_id: body.instance.id });
      return err(licenseError("wrong_product"));
    }
    const identity: LicenseIdentity = { key, instanceId: body.instance.id, instanceName };
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
    if (!this.variantAllowed(body.meta)) return invalidRecord(stored, "wrong_product", at);
    return activatedRecord(stored, body, at);
  }
}

export function createLicenseClient(options: LicenseClientOptions): LicenseClient {
  return new LemonSqueezyLicenseClient(options);
}

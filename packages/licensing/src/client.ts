import { err, ok, systemClock } from "@browserforge/shared";
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
  FetchLike,
  LicenseApi,
  LicenseClient,
  LicenseClientOptions,
  LicenseError,
  LicenseResult,
  LicenseState,
  LicenseStorage,
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

export function createLicenseClient(options: LicenseClientOptions): LicenseClient {
  const { productName } = options;
  const now = options.now ?? systemClock;
  const gracePeriodMs = options.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
  const revalidateEveryMs = options.revalidateEveryMs ?? DEFAULT_REVALIDATE_EVERY_MS;
  const api: LicenseApi =
    options.api ?? createLicenseApi(options.fetch ?? defaultFetch, options.apiBaseUrl);
  const repository = createLicenseRepository(options.storage, productName);
  const allowedVariants = new Set(options.allowedVariantIds ?? []);
  const listeners = new Set<(state: LicenseState) => void>();

  const derive = (stored: StoredLicense | undefined): LicenseState =>
    deriveLicenseState(stored, now(), gracePeriodMs);

  function variantAllowed(meta: LicenseResponse["meta"]): boolean {
    if (allowedVariants.size === 0) return true;
    const variantId = meta?.variant_id;
    return variantId !== undefined && allowedVariants.has(variantId);
  }

  /** `valid: true` for an active key of an allowed variant. */
  function isValidAnswer(body: LicenseResponse): boolean {
    const status = body.license_key?.status ?? "active";
    return body.valid === true && status === "active" && variantAllowed(body.meta);
  }

  function notify(state: LicenseState): void {
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
        // A misbehaving subscriber must not break licence bookkeeping.
      }
    }
  }

  /** Persists `record`, derives the resulting state and tells subscribers. */
  async function commit(record: StoredLicense | undefined): Promise<LicenseState> {
    await repository.save(record);
    const state = derive(record);
    notify(state);
    return state;
  }

  async function getInstanceName(): Promise<string> {
    const suffix = await repository.instanceSuffix();
    const userAgent = options.userAgent ?? globalThis.navigator?.userAgent;
    return buildInstanceName(productName, browserFamily(userAgent), suffix);
  }

  /**
   * Same key as the one already on disk (typical after "grace expired" or a store hiccup):
   * re-validate the instance we hold instead of consuming a second activation seat.
   * Resolves to `null` when the server no longer accepts that instance.
   */
  async function revalidateOwnInstance(
    stored: StoredKeyed,
  ): Promise<LicenseResult<LicenseState> | null> {
    const check = await api.validate({ license_key: stored.key, instance_id: stored.instanceId });
    if (!check.ok) return check;
    if (!isValidAnswer(check.value.body)) return null;
    return ok(await commit(activatedRecord(stored, check.value.body, now())));
  }

  async function activateFresh(key: string): Promise<LicenseResult<LicenseState>> {
    const instanceName = await getInstanceName();
    const res = await api.activate({ license_key: key, instance_name: instanceName });
    if (!res.ok) return res;
    const { body } = res.value;
    if (!body.activated || !body.instance) return err(activationError(body));
    if (!variantAllowed(body.meta)) {
      // Release the seat we just consumed; the key is for a different product.
      await api.deactivate({ license_key: key, instance_id: body.instance.id });
      return err(licenseError("wrong_product"));
    }
    const identity: LicenseIdentity = { key, instanceId: body.instance.id, instanceName };
    return ok(await commit(activatedRecord(identity, body, now())));
  }

  async function activate(input: string): Promise<LicenseResult<LicenseState>> {
    const key = normalizeKey(input);
    if (key.length === 0) return err(licenseError("invalid_key"));
    const stored = await repository.load();
    if (stored && stored.kind !== "free" && stored.key === key) {
      const revalidated = await revalidateOwnInstance(stored);
      if (revalidated) return revalidated;
      // The instance is gone or the key changed state: fall through to a fresh activation.
    }
    return activateFresh(key);
  }

  /** Whether a non-forced `validate()` should hit the network for this record. */
  function isStale(stored: StoredKeyed): boolean {
    if (stored.kind === "invalid") return false;
    const fresh = now() - stored.lastValidatedAt < revalidateEveryMs;
    return !(fresh && stored.lastFailedAt === undefined);
  }

  /** Transport failure: keep whatever we knew, but remember that we could not confirm it. */
  function recordTransportFailure(stored: StoredKeyed): Promise<LicenseState> {
    if (stored.kind === "invalid") return Promise.resolve(derive(stored));
    return commit({ ...stored, lastFailedAt: now() });
  }

  function recordVerdict(stored: StoredKeyed, body: LicenseResponse): StoredLicense {
    const at = now();
    const status = body.license_key?.status ?? "active";
    if (!body.valid || status !== "active") return invalidRecord(stored, rejectionReason(body), at);
    if (!variantAllowed(body.meta)) return invalidRecord(stored, "wrong_product", at);
    return activatedRecord(stored, body, at);
  }

  async function validate(opts: ValidateOptions = {}): Promise<LicenseState> {
    const stored = await repository.load();
    if (!stored || stored.kind === "free") return derive(stored);
    if (!opts.force && !isStale(stored)) return derive(stored);
    const res = await api.validate({ license_key: stored.key, instance_id: stored.instanceId });
    if (!res.ok) return recordTransportFailure(stored);
    return commit(recordVerdict(stored, res.value.body));
  }

  async function deactivate(): Promise<LicenseResult<void>> {
    const stored = await repository.load();
    if (!stored || stored.kind === "free") return err(licenseError("not_activated"));
    const res = await api.deactivate({ license_key: stored.key, instance_id: stored.instanceId });
    if (!res.ok) return err(res.error);
    const { body } = res.value;
    const code = classifyApiError(body.error, body.license_key?.status);
    if (!deactivationSucceeded(body, code)) return err(licenseError(code, body.error ?? undefined));
    await commit({ v: 1, kind: "free", reason: "deactivated" });
    return ok(undefined);
  }

  async function getState(): Promise<LicenseState> {
    return derive(await repository.load());
  }

  async function hasStoredKey(): Promise<boolean> {
    const stored = await repository.load();
    return stored !== undefined && stored.kind !== "free";
  }

  function onChange(listener: (state: LicenseState) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  const client: LicenseClient = {
    productName,
    alarmName: revalidationAlarmName(productName),
    activate,
    validate,
    deactivate,
    getState,
    isPro: async () => isProState(await getState()),
    onChange,
    getInstanceName,
    hasStoredKey,
    scheduleRevalidation: (alarms, scheduleOptions) =>
      scheduleRevalidation(alarms, client, { revalidateEveryMs, ...scheduleOptions }),
  };
  return client;
}

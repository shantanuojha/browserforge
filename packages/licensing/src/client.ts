import { z } from "zod";
import { err, ok } from "@browserforge/shared";
import {
  LEMON_SQUEEZY_API,
  callLicenseApi,
  classifyApiError,
  licenseError,
  parseExpiresAt,
  type LicenseResponse,
} from "./api.js";
import { browserFamily, buildInstanceName, randomInstanceSuffix } from "./instance.js";
import { maskKey, normalizeKey } from "./mask.js";
import type {
  AlarmsLike,
  LicenseClient,
  LicenseClientOptions,
  LicenseInvalidReason,
  LicenseResult,
  LicenseState,
  ProLicenseInfo,
  ScheduleRevalidationOptions,
  ValidateOptions,
} from "./types.js";

export const DEFAULT_GRACE_PERIOD_MS = 14 * 24 * 3600 * 1000;
export const DEFAULT_REVALIDATE_EVERY_MS = 7 * 24 * 3600 * 1000;

/* ------------------------------------------------------------------------------------------ */
/* Persisted shape (validated on read so corrupted storage degrades to "free", never throws). */

const InvalidReasonSchema = z.enum([
  "expired",
  "disabled",
  "wrong_product",
  "not_found",
  "deactivated",
  "unknown",
]);

const StoredActivatedSchema = z.object({
  v: z.literal(1),
  kind: z.literal("activated"),
  key: z.string(),
  instanceId: z.string(),
  instanceName: z.string(),
  lastValidatedAt: z.number(),
  /** Set when the most recent validation attempt failed for transport reasons. */
  lastFailedAt: z.number().optional(),
  expiresAt: z.number().optional(),
  email: z.string().optional(),
});

const StoredInvalidSchema = z.object({
  v: z.literal(1),
  kind: z.literal("invalid"),
  key: z.string(),
  instanceId: z.string(),
  instanceName: z.string(),
  reason: InvalidReasonSchema,
  checkedAt: z.number(),
});

const StoredFreeSchema = z.object({
  v: z.literal(1),
  kind: z.literal("free"),
  reason: z.enum(["grace_expired", "deactivated"]).optional(),
});

const StoredSchema = z.discriminatedUnion("kind", [
  StoredActivatedSchema,
  StoredInvalidSchema,
  StoredFreeSchema,
]);

type StoredActivated = z.infer<typeof StoredActivatedSchema>;
type StoredInvalid = z.infer<typeof StoredInvalidSchema>;
type Stored = z.infer<typeof StoredSchema>;

/** Storage key holding the licence record for a product. */
export function licenseStorageKey(productName: string): string {
  return `${productName}:license`;
}

/** Storage key holding the per-profile random suffix used in `instance_name`. */
export function instanceSuffixStorageKey(productName: string): string {
  return `${productName}:license-instance-suffix`;
}

/** Alarm name registered by `scheduleRevalidation`. */
export function revalidationAlarmName(productName: string): string {
  return `${productName}:license-revalidate`;
}

/** True for the two states in which Pro features should be available. */
export function isProState(state: LicenseState | null | undefined): boolean {
  return state?.kind === "pro" || state?.kind === "grace";
}

/* ------------------------------------------------------------------------------------------ */

export function createLicenseClient(options: LicenseClientOptions): LicenseClient {
  const { productName, storage } = options;
  const fetchImpl =
    options.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const gracePeriodMs = options.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
  const revalidateEveryMs = options.revalidateEveryMs ?? DEFAULT_REVALIDATE_EVERY_MS;
  const allowedVariants = new Set(options.allowedVariantIds ?? []);
  const baseUrl = options.apiBaseUrl ?? LEMON_SQUEEZY_API;
  const licenseKey = licenseStorageKey(productName);
  const suffixKey = instanceSuffixStorageKey(productName);
  const alarmName = revalidationAlarmName(productName);
  const listeners = new Set<(state: LicenseState) => void>();

  async function loadStored(): Promise<Stored | undefined> {
    const record = await storage.get(licenseKey);
    const parsed = StoredSchema.safeParse(record[licenseKey]);
    return parsed.success ? parsed.data : undefined;
  }

  function emit(state: LicenseState): void {
    for (const cb of listeners) {
      try {
        cb(state);
      } catch {
        // A misbehaving subscriber must not break licence bookkeeping.
      }
    }
  }

  async function save(stored: Stored | undefined): Promise<LicenseState> {
    if (stored) await storage.set({ [licenseKey]: stored });
    else await storage.remove(licenseKey);
    const state = derive(stored, now());
    emit(state);
    return state;
  }

  function proInfo(stored: StoredActivated): ProLicenseInfo {
    const info: {
      -readonly [K in keyof ProLicenseInfo]: ProLicenseInfo[K];
    } = {
      key: maskKey(stored.key),
      instanceId: stored.instanceId,
      instanceName: stored.instanceName,
      lastValidatedAt: stored.lastValidatedAt,
    };
    if (stored.expiresAt !== undefined) info.expiresAt = stored.expiresAt;
    if (stored.email !== undefined) info.email = stored.email;
    return info;
  }

  function derive(stored: Stored | undefined, at: number): LicenseState {
    if (!stored) return { kind: "free" };
    switch (stored.kind) {
      case "free":
        return stored.reason ? { kind: "free", reason: stored.reason } : { kind: "free" };
      case "invalid":
        return { kind: "invalid", reason: stored.reason, key: maskKey(stored.key) };
      case "activated": {
        const info = proInfo(stored);
        if (stored.lastFailedAt === undefined) return { kind: "pro", ...info };
        const graceEndsAt = stored.lastValidatedAt + gracePeriodMs;
        if (at <= graceEndsAt) return { kind: "grace", graceEndsAt, ...info };
        return { kind: "free", reason: "grace_expired" };
      }
    }
  }

  function variantAllowed(meta: LicenseResponse["meta"]): boolean {
    if (allowedVariants.size === 0) return true;
    const variantId = meta?.variant_id;
    return variantId !== undefined && allowedVariants.has(variantId);
  }

  function activatedRecord(
    key: string,
    instanceId: string,
    instanceName: string,
    body: LicenseResponse,
    at: number,
  ): StoredActivated {
    const record: StoredActivated = {
      v: 1,
      kind: "activated",
      key,
      instanceId,
      instanceName,
      lastValidatedAt: at,
    };
    const expiresAt = parseExpiresAt(body.license_key?.expires_at);
    if (expiresAt !== undefined) record.expiresAt = expiresAt;
    const email = body.meta?.customer_email;
    if (email) record.email = email;
    return record;
  }

  function invalidRecord(
    stored: StoredActivated | StoredInvalid,
    reason: LicenseInvalidReason,
    at: number,
  ): StoredInvalid {
    return {
      v: 1,
      kind: "invalid",
      key: stored.key,
      instanceId: stored.instanceId,
      instanceName: stored.instanceName,
      reason,
      checkedAt: at,
    };
  }

  function rejectionReason(body: LicenseResponse): LicenseInvalidReason {
    const status = body.license_key?.status;
    if (status === "expired") return "expired";
    if (status === "disabled") return "disabled";
    switch (classifyApiError(body.error, status)) {
      case "expired":
        return "expired";
      case "disabled":
        return "disabled";
      case "invalid_key":
        return "not_found";
      case "not_activated":
        return "deactivated";
      default:
        return "unknown";
    }
  }

  async function getInstanceName(): Promise<string> {
    const record = await storage.get(suffixKey);
    const existing = record[suffixKey];
    let suffix: string;
    if (typeof existing === "string" && existing.length > 0) {
      suffix = existing;
    } else {
      suffix = randomInstanceSuffix();
      await storage.set({ [suffixKey]: suffix });
    }
    const userAgent = options.userAgent ?? globalThis.navigator?.userAgent;
    return buildInstanceName(productName, browserFamily(userAgent), suffix);
  }

  async function activate(input: string): Promise<LicenseResult<LicenseState>> {
    const key = normalizeKey(input);
    if (key.length === 0) return err(licenseError("invalid_key"));

    const instanceName = await getInstanceName();
    const res = await callLicenseApi(fetchImpl, baseUrl, "activate", {
      license_key: key,
      instance_name: instanceName,
    });
    if (!res.ok) return res;

    const { body } = res.value;
    if (!body.activated || !body.instance) {
      const code = classifyApiError(body.error, body.license_key?.status);
      return err(
        licenseError(code === "not_activated" ? "unknown" : code, body.error ?? undefined),
      );
    }

    if (!variantAllowed(body.meta)) {
      // Release the seat we just consumed; the key is for a different product.
      await callLicenseApi(fetchImpl, baseUrl, "deactivate", {
        license_key: key,
        instance_id: body.instance.id,
      });
      return err(licenseError("wrong_product"));
    }

    const state = await save(activatedRecord(key, body.instance.id, instanceName, body, now()));
    return ok(state);
  }

  async function validate(opts: ValidateOptions = {}): Promise<LicenseState> {
    const stored = await loadStored();
    const at = now();
    if (!stored || stored.kind === "free") return derive(stored, at);
    if (!opts.force) {
      if (stored.kind === "invalid") return derive(stored, at);
      const fresh = at - stored.lastValidatedAt < revalidateEveryMs;
      if (fresh && stored.lastFailedAt === undefined) return derive(stored, at);
    }

    const res = await callLicenseApi(fetchImpl, baseUrl, "validate", {
      license_key: stored.key,
      instance_id: stored.instanceId,
    });

    if (!res.ok) {
      // Transport failure: keep whatever we knew, but remember that we could not confirm it.
      if (stored.kind === "invalid") return derive(stored, at);
      return save({ ...stored, lastFailedAt: at });
    }

    const { body } = res.value;
    const status = body.license_key?.status ?? "active";
    if (body.valid && status === "active") {
      if (!variantAllowed(body.meta)) return save(invalidRecord(stored, "wrong_product", at));
      return save(activatedRecord(stored.key, stored.instanceId, stored.instanceName, body, at));
    }
    return save(invalidRecord(stored, rejectionReason(body), at));
  }

  async function deactivate(): Promise<LicenseResult<void>> {
    const stored = await loadStored();
    if (!stored || stored.kind === "free") return err(licenseError("not_activated"));

    const res = await callLicenseApi(fetchImpl, baseUrl, "deactivate", {
      license_key: stored.key,
      instance_id: stored.instanceId,
    });
    if (!res.ok) return err(res.error);

    const { body } = res.value;
    const code = classifyApiError(body.error, body.license_key?.status);
    // "Already gone" on the server is a success from the user's point of view.
    if (body.deactivated || code === "invalid_key" || code === "not_activated") {
      await save({ v: 1, kind: "free", reason: "deactivated" });
      return ok(undefined);
    }
    return err(licenseError(code, body.error ?? undefined));
  }

  async function getState(): Promise<LicenseState> {
    return derive(await loadStored(), now());
  }

  async function hasStoredKey(): Promise<boolean> {
    const stored = await loadStored();
    return stored !== undefined && stored.kind !== "free";
  }

  function onChange(cb: (state: LicenseState) => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }

  const client: LicenseClient = {
    productName,
    alarmName,
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

/* ------------------------------------------------------------------------------------------ */

const MIN_ALARM_PERIOD_MINUTES = 1;

/**
 * Registers a periodic `chrome.alarms` alarm named `${productName}:license-revalidate` and a
 * handler that force-revalidates when it fires. Call once from the background entrypoint.
 * Returns a function that removes the listener and clears the alarm.
 */
export function scheduleRevalidation(
  alarms: AlarmsLike,
  client: LicenseClient,
  options: ScheduleRevalidationOptions & { revalidateEveryMs?: number } = {},
): () => void {
  const name = client.alarmName;
  const everyMs = options.revalidateEveryMs ?? DEFAULT_REVALIDATE_EVERY_MS;
  const periodInMinutes = Math.max(MIN_ALARM_PERIOD_MINUTES, Math.round(everyMs / 60_000));
  const handler = (alarm: { name: string }) => {
    if (alarm.name !== name) return;
    void client.validate({ force: true }).catch(() => undefined);
  };

  alarms.onAlarm.addListener(handler);
  void Promise.resolve(alarms.create(name, { periodInMinutes, delayInMinutes: 1 })).catch(
    () => undefined,
  );
  if (options.validateOnStart ?? true) {
    void client.validate().catch(() => undefined);
  }

  return () => {
    alarms.onAlarm.removeListener(handler);
    void Promise.resolve(alarms.clear?.(name)).catch(() => undefined);
  };
}

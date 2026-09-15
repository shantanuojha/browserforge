/**
 * Storage boundary of the client: reads and writes the licence record and the per-profile
 * instance suffix through the `LicenseStorage` port. No interpretation happens here.
 */
import { randomInstanceSuffix } from "./instance.js";
import {
  instanceSuffixStorageKey,
  licenseStorageKey,
  parseStoredLicense,
  type StoredLicense,
} from "./license-record.js";
import type { LicenseStorage } from "./types.js";

export interface LicenseRepository {
  load(): Promise<StoredLicense | undefined>;
  save(record: StoredLicense | undefined): Promise<void>;
  /** Per-profile random suffix for the instance name, created and persisted on first use. */
  instanceSuffix(): Promise<string>;
}

// The parameter is deliberately not called `storage`: WXT's vitest plugin auto-imports
// `wxt/utils/storage` for any bare `storage` identifier it finds, even in workspace packages.
export function createLicenseRepository(
  area: LicenseStorage,
  productName: string,
): LicenseRepository {
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

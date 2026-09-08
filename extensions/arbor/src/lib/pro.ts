import { getEntitlements } from "@browserforge/licensing";
import { getLicenseClient, PRO_PAGE_URL, PRO_PRICE_TEXT } from "@/lib/licensing";

/** Feature ids gated behind Arbor Pro (see README). */
export const PRO_FEATURES = {
  scheduledBackups: "scheduled-backups",
  driveBackup: "drive-backup",
  powerKeys: "power-keys",
  multiProfile: "multi-profile",
} as const;

export type ProFeature = (typeof PRO_FEATURES)[keyof typeof PRO_FEATURES];

export { PRO_PRICE_TEXT };
export const PRO_URL = PRO_PAGE_URL;

/**
 * Google Drive backup is not implemented yet. While this is `false` the options page hides the
 * toggle and never asks for the optional `identity` permission (which is also absent from the
 * manifest). Flip it, and re-add `optional_permissions: ["identity"]`, when uploading ships.
 */
export const DRIVE_BACKUP_ENABLED = false as boolean;

/**
 * Single gate used everywhere. Reads the cached licence state through the Lemon Squeezy client
 * (see `lib/licensing.ts`); per-feature checks route through here so they can be refined later
 * without touching callers. Resolves to `false` when licensing is not configured.
 */
export async function isPro(): Promise<boolean> {
  try {
    const entitlements = await getEntitlements(getLicenseClient());
    return entitlements.pro === true;
  } catch {
    return false;
  }
}

export async function hasFeature(_feature: ProFeature): Promise<boolean> {
  return isPro();
}

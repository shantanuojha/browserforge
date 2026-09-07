import { getEntitlements } from "@browserforge/licensing";

/** Feature ids gated behind Arbor Pro (see README). */
export const PRO_FEATURES = {
  scheduledBackups: "scheduled-backups",
  driveBackup: "drive-backup",
  powerKeys: "power-keys",
  multiProfile: "multi-profile",
} as const;

export type ProFeature = (typeof PRO_FEATURES)[keyof typeof PRO_FEATURES];

export const PRO_PRICE_TEXT = "Pro \u2014 $15 one-time";
export const PRO_URL = "https://browserforge.dev/arbor#pro";

/**
 * Single gate used everywhere. Today `@browserforge/licensing` only knows a boolean `pro`;
 * per-feature checks route through here so they can be refined later without touching callers.
 */
export async function isPro(): Promise<boolean> {
  try {
    const entitlements = await getEntitlements();
    return entitlements.pro === true;
  } catch {
    return false;
  }
}

export async function hasFeature(_feature: ProFeature): Promise<boolean> {
  return isPro();
}

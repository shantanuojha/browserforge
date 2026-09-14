/**
 * What Pro is, in words: the feature ids and the flags that hide unfinished Pro features. The
 * licence itself is handled by `@browserforge/licensing` through `adapters/licensing.ts`, which
 * also hosts the `isPro()` gate.
 */
import { PRO_PAGE_URL, PRO_PRICE_TEXT } from "./licensing-config";

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

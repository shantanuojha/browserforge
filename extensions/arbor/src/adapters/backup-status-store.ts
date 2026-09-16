/**
 * The last scheduled-backup outcome, in `browser.storage.local`. The background writes it after
 * every tick; the Options page reads and watches it. Every read passes through
 * `parseScheduledRun`, so a malformed record shows as "nothing recorded" rather than crashing.
 */
import { browser } from "wxt/browser";
import type { BackupStatusStore } from "../lib/background/ports";
import { BACKUP_STATUS_KEY, parseScheduledRun, type ScheduledRun } from "../lib/backups";

export async function loadScheduledRun(): Promise<ScheduledRun | undefined> {
  const result = await browser.storage.local.get(BACKUP_STATUS_KEY);
  return parseScheduledRun(result[BACKUP_STATUS_KEY]);
}

export async function saveScheduledRun(run: ScheduledRun): Promise<void> {
  await browser.storage.local.set({ [BACKUP_STATUS_KEY]: run });
}

export function watchScheduledRun(callback: (run: ScheduledRun | undefined) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== "local") return;
    const change = changes[BACKUP_STATUS_KEY];
    if (change) callback(parseScheduledRun(change.newValue));
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

export const browserBackupStatusStore: BackupStatusStore = { save: saveScheduledRun };

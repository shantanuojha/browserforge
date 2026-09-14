import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "@browserforge/shared";
import { downloadJson } from "@/adapters/files";
import { msg } from "@/adapters/messaging";
import type { BackupMeta } from "@/lib/backups";
import { fileStamp, formatDateTime } from "@/lib/format";

export interface BackupsApi {
  backups: BackupMeta[];
  backupNow(): Promise<void>;
  download(backup: BackupMeta): Promise<void>;
  remove(backup: BackupMeta): Promise<void>;
}

/**
 * The stored backups list and the operations the Options page offers on it. Outcomes and
 * failures are reported through `setStatus` for the notice under the list.
 */
export function useBackups(setStatus: (status: string) => void): BackupsApi {
  const [backups, setBackups] = useState<BackupMeta[]>([]);

  const refresh = useCallback(async () => {
    try {
      setBackups(await msg.listBackups.send());
    } catch (e) {
      setStatus(errorMessage(e));
    }
  }, [setStatus]);

  useEffect(() => {
    let cancelled = false;
    msg.listBackups
      .send()
      .then((list) => {
        if (!cancelled) setBackups(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) setStatus(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [setStatus]);

  const backupNow = async () => {
    try {
      const meta = await msg.runBackupNow.send();
      setStatus(`Backup written: ${formatDateTime(meta.ts)} (${meta.nodeCount} nodes).`);
      await refresh();
    } catch (e) {
      setStatus(errorMessage(e));
    }
  };

  const download = async (b: BackupMeta) => {
    const data = await msg.getBackup.send({ ts: b.ts });
    if (!data) {
      setStatus("That backup no longer exists.");
      return;
    }
    downloadJson(`arbor-backup-${fileStamp(new Date(b.ts))}.json`, data);
  };

  const remove = async (b: BackupMeta) => {
    await msg.deleteBackup.send({ ts: b.ts });
    await refresh();
  };

  return { backups, backupNow, download, remove };
}

import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "@browserforge/shared";
import { msg } from "@/adapters/messaging";
import type { StartupInfo } from "@/lib/messages";
import type { QuarantinedOp, SnapshotMeta } from "@/lib/store/types";

export interface RecoveryData {
  /** `null` until the first answer arrived. */
  snapshots: SnapshotMeta[] | null;
  quarantine: QuarantinedOp[];
  startup: StartupInfo | null;
  refresh(): Promise<void>;
}

async function fetchAll() {
  const [snapshots, quarantine, startup] = await Promise.all([
    msg.listSnapshots.send(),
    msg.listQuarantine.send(),
    msg.getStartupInfo.send(),
  ]);
  return { snapshots, quarantine, startup };
}

/** Everything the Recovery screen shows, loaded once and on demand; load errors go to `onError`. */
export function useRecoveryData(onError: (message: string) => void): RecoveryData {
  const [snapshots, setSnapshots] = useState<SnapshotMeta[] | null>(null);
  const [quarantine, setQuarantine] = useState<QuarantinedOp[]>([]);
  const [startup, setStartup] = useState<StartupInfo | null>(null);

  const refresh = useCallback(async () => {
    const data = await fetchAll();
    setSnapshots(data.snapshots);
    setQuarantine(data.quarantine);
    setStartup(data.startup);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchAll()
      .then((data) => {
        if (cancelled) return;
        setSnapshots(data.snapshots);
        setQuarantine(data.quarantine);
        setStartup(data.startup);
      })
      .catch((e: unknown) => {
        if (!cancelled) onError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [onError]);

  return { snapshots, quarantine, startup, refresh };
}

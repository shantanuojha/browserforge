import { useEffect, useState } from "react";
import { loadScheduledRun, watchScheduledRun } from "@/adapters/backup-status-store";
import type { ScheduledRun } from "@/lib/backups";

/** The last scheduled backup tick, kept live: updates when the background records the next one. */
export function useScheduledRun(): ScheduledRun | undefined {
  const [run, setRun] = useState<ScheduledRun | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    loadScheduledRun()
      .then((stored) => {
        if (!cancelled) setRun(stored);
      })
      .catch(() => undefined); // unreadable status: the line stays hidden, nothing else depends on it
    const unwatch = watchScheduledRun((next) => setRun(next));
    return () => {
      cancelled = true;
      unwatch();
    };
  }, []);
  return run;
}

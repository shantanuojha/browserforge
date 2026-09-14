import { createLogger, type Clock } from "@browserforge/shared";
import { appendLog, type LogEntry } from "../log";

/** Storage for the rolling activity log; `WxtStorageItem<LogEntry[]>` satisfies it. */
export interface ActivityLogStore {
  getValue(): Promise<LogEntry[]>;
  setValue(entries: LogEntry[]): Promise<void>;
  watch(callback: (next: LogEntry[] | null) => void): () => void;
}

export type ActivityEvent = Omit<LogEntry, "at">;
export type ErrorContext = Partial<Pick<LogEntry, "from" | "to" | "tabId" | "ruleId">>;

export interface ActivityRecorder {
  record(event: ActivityEvent): Promise<void>;
  recordError(detail: string, context?: ErrorContext): Promise<void>;
}

const log = createLogger("reroute:activity");

/**
 * Appends to the persisted log, loading it lazily on first use. The options page clears the
 * log by writing `[]`; the watcher keeps the in-memory copy in step so the next event does not
 * resurrect the cleared entries.
 */
export function createActivityRecorder(store: ActivityLogStore, clock: Clock): ActivityRecorder {
  let entries: LogEntry[] = [];
  let loaded = false;

  store.watch((next) => {
    entries = next ?? [];
    loaded = true;
  });

  async function record(event: ActivityEvent): Promise<void> {
    if (!loaded) {
      entries = await store.getValue();
      loaded = true;
    }
    entries = appendLog(entries, { at: clock(), ...event });
    try {
      await store.setValue(entries);
    } catch (e) {
      // Storage quota or transient failure; the in-memory log still has the entry.
      log.warn("could not persist activity log", e);
    }
  }

  return {
    record,
    recordError: (detail, context = {}) => record({ kind: "error", from: "", ...context, detail }),
  };
}

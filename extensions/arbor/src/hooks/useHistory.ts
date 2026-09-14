import { useCallback, useEffect, useRef, useState } from "react";
import { msg } from "@/adapters/messaging";
import { sessionArea } from "@/adapters/session-area";
import { HistoryStack, type HistoryEntry } from "@/lib/history";

const KEY = "history";

export interface HistoryApi {
  /** Record an entry (a `null` from a builder means "nothing to undo" and is ignored). */
  push(entry: HistoryEntry | null): void;
  /** Run the top entry's undo steps; resolves with the entry, or `null` when nothing happened. */
  undo(): Promise<HistoryEntry | null>;
  redo(): Promise<HistoryEntry | null>;
  canUndo: boolean;
  canRedo: boolean;
  /** Label of what undo / redo would do next ("delete 3 tabs"), for tooltips. */
  undoLabel: string | null;
  redoLabel: string | null;
}

interface Summary {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

const summarize = (stack: HistoryStack): Summary => ({
  canUndo: stack.canUndo,
  canRedo: stack.canRedo,
  undoLabel: stack.peekUndo()?.label ?? null,
  redoLabel: stack.peekRedo()?.label ?? null,
});

type Direction = "undo" | "redo";

/** Run every step of `entry` in `direction` through the background, in order. */
async function runSteps(entry: HistoryEntry, direction: Direction): Promise<void> {
  for (const step of direction === "undo" ? entry.undo : entry.redo) {
    await msg.applyHistoryStep.send(step);
  }
}

/**
 * Adopt the stack persisted by an earlier panel of this browser session, unless this panel has
 * recorded something itself meanwhile.
 */
function useRestoredStack(
  stackRef: { current: HistoryStack },
  setSummary: (summary: Summary) => void,
): void {
  useEffect(() => {
    const area = sessionArea();
    if (!area) return;
    let disposed = false;
    area
      .get(KEY)
      .then((raw) => {
        if (disposed) return;
        const restored = HistoryStack.fromJSON(raw);
        if ((restored.canUndo || restored.canRedo) && !stackRef.current.canUndo) {
          stackRef.current = restored;
          setSummary(summarize(restored));
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [stackRef, setSummary]);
}

/**
 * The panel's undo/redo stack (see `lib/history.ts`). Steps run in the background through
 * `applyHistoryStep`; a failing step reports through `onError` and drops the entry, because the
 * tree has moved on in a way the entry did not foresee. The stack is mirrored into
 * `storage.session` so closing and reopening the panel keeps it for the browser session.
 */
export function useHistory(onError: (e: unknown) => void): HistoryApi {
  // The stack itself is mutable state kept out of render; `summary` is what the UI reads.
  const stackRef = useRef(new HistoryStack());
  const busyRef = useRef(false);
  const [summary, setSummary] = useState<Summary>({
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
  });

  const persist = useCallback(() => {
    const stack = stackRef.current;
    setSummary(summarize(stack));
    void sessionArea()
      ?.set(KEY, stack.toJSON())
      .catch(() => undefined);
  }, []);

  useRestoredStack(stackRef, setSummary);

  const push = useCallback(
    (entry: HistoryEntry | null) => {
      if (!entry) return;
      stackRef.current.push(entry);
      persist();
    },
    [persist],
  );

  const runEntry = useCallback(
    async (direction: Direction): Promise<HistoryEntry | null> => {
      if (busyRef.current) return null;
      const stack = stackRef.current;
      const entry = direction === "undo" ? stack.takeUndo() : stack.takeRedo();
      if (!entry) return null;
      busyRef.current = true;
      try {
        await runSteps(entry, direction);
        if (direction === "undo") stack.undone(entry);
        else stack.redone(entry);
        return entry;
      } catch (e) {
        onError(e);
        return null;
      } finally {
        busyRef.current = false;
        persist();
      }
    },
    [onError, persist],
  );

  const undo = useCallback(() => runEntry("undo"), [runEntry]);
  const redo = useCallback(() => runEntry("redo"), [runEntry]);

  return { push, undo, redo, ...summary };
}

/**
 * Pushes the live tree to every connected side panel. Bursts of store changes are coalesced into
 * one message per `debounceMs`; a panel that cannot be reached is dropped. Pure: the port is an
 * interface the adapter (`adapters/tree-port.ts`) fills in.
 */
import type { TreePortMessage, TreeState } from "../messages";

/** One connected panel. */
export interface TreePortSink {
  post(message: TreePortMessage): void;
  onDisconnect(listener: () => void): void;
}

export interface TreeBroadcasterDeps {
  currentState(): TreeState;
  /** Panels connecting before startup finished get their first tree once this resolves. */
  ready: Promise<unknown>;
  debounceMs?: number;
}

export interface TreeBroadcaster {
  /** Adopt a freshly connected panel and send it the current tree once the background is ready. */
  accept(sink: TreePortSink): void;
  /** Send the current tree to every panel, debounced. */
  scheduleBroadcast(): void;
}

const DEFAULT_DEBOUNCE_MS = 80;

export function createTreeBroadcaster(deps: TreeBroadcasterDeps): TreeBroadcaster {
  const sinks = new Set<TreePortSink>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const message = (): TreePortMessage => ({ type: "tree", state: deps.currentState() });

  const broadcastNow = (): void => {
    if (!sinks.size) return;
    const current = message();
    for (const sink of sinks) {
      try {
        sink.post(current);
      } catch {
        sinks.delete(sink); // the panel went away without disconnecting cleanly
      }
    }
  };

  return {
    accept(sink) {
      sinks.add(sink);
      sink.onDisconnect(() => sinks.delete(sink));
      void deps.ready.then(() => sink.post(message()));
    },
    scheduleBroadcast() {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        broadcastNow();
      }, deps.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    },
  };
}

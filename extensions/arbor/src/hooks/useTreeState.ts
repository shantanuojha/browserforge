import { useEffect, useMemo, useState } from "react";
import { browser } from "wxt/browser";
import { msg, TREE_PORT, type TreePortMessage, type TreeState } from "@/lib/messages";
import { createTree, type Tree } from "@/lib/model";

function isTreeMessage(value: unknown): value is TreePortMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "tree" &&
    typeof (value as { state?: unknown }).state === "object"
  );
}

export interface TreeStateHook {
  state: TreeState | null;
  tree: Tree;
  error: string | null;
  connected: boolean;
}

/** Live tree pushed from the background over a long-lived port, with a one-shot fallback. */
export function useTreeState(): TreeStateHook {
  const [state, setState] = useState<TreeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = (): (() => void) => {
      const port = browser.runtime.connect({ name: TREE_PORT });
      const onMessage = (m: unknown) => {
        if (isTreeMessage(m)) {
          setState(m.state);
          setError(null);
          setConnected(true);
        }
      };
      const onDisconnect = () => {
        setConnected(false);
        if (!disposed) retry = setTimeout(() => (cleanup = connect()), 800);
      };
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
      return () => {
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
        try {
          port.disconnect();
        } catch {
          // already gone
        }
      };
    };

    let cleanup = connect();
    void msg.getState
      .send()
      .then((s) => {
        if (!disposed) setState((prev) => prev ?? s);
      })
      .catch((e: unknown) => {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      disposed = true;
      if (retry !== null) clearTimeout(retry);
      cleanup();
    };
  }, []);

  const tree = useMemo(() => createTree(state?.nodes ?? []), [state]);
  return { state, tree, error, connected };
}

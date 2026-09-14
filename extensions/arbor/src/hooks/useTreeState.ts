import { useEffect, useMemo, useState } from "react";
import { errorMessage } from "@browserforge/shared";
import { msg } from "@/adapters/messaging";
import { connectTreePort, type TreePortSubscription } from "@/adapters/tree-port";
import type { TreeState } from "@/lib/messages";
import { createTree, type Tree } from "@/lib/model";

const RECONNECT_DELAY_MS = 800;

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
    let subscription: TreePortSubscription;

    const connect = (): TreePortSubscription =>
      connectTreePort({
        onState(next) {
          setState(next);
          setError(null);
          setConnected(true);
        },
        onDisconnect() {
          setConnected(false);
          if (!disposed) retry = setTimeout(() => (subscription = connect()), RECONNECT_DELAY_MS);
        },
      });

    subscription = connect();
    void msg.getState
      .send()
      .then((s) => {
        if (!disposed) setState((prev) => prev ?? s);
      })
      .catch((e: unknown) => {
        if (!disposed) setError(errorMessage(e));
      });

    return () => {
      disposed = true;
      if (retry !== null) clearTimeout(retry);
      subscription.disconnect();
    };
  }, []);

  const tree = useMemo(() => createTree(state?.nodes ?? []), [state]);
  return { state, tree, error, connected };
}

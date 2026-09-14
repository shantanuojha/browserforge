/**
 * The long-lived `runtime.connect` port that pushes the live tree from the background to every
 * open side panel. The background side (`onTreePortConnect`) hands connections to the
 * broadcaster; the page side (`connectTreePort`) subscribes and reconnects when the worker goes.
 */
import { browser, type Browser } from "wxt/browser";
import type { TreePortSink } from "../lib/background/tree-broadcaster";
import { isTreePortMessage, TREE_PORT, type TreeState } from "../lib/messages";

export function onTreePortConnect(accept: (sink: TreePortSink) => void): void {
  browser.runtime.onConnect.addListener((port: Browser.runtime.Port) => {
    if (port.name !== TREE_PORT) return;
    accept({
      post: (message) => port.postMessage(message),
      onDisconnect: (listener) => port.onDisconnect.addListener(listener),
    });
  });
}

export interface TreePortSubscription {
  disconnect(): void;
}

export interface TreePortHandlers {
  onState(state: TreeState): void;
  onDisconnect(): void;
}

/** Connect to the background's tree port; every valid `tree` message reaches `onState`. */
export function connectTreePort(handlers: TreePortHandlers): TreePortSubscription {
  const port = browser.runtime.connect({ name: TREE_PORT });
  const onMessage = (m: unknown) => {
    if (isTreePortMessage(m)) handlers.onState(m.state);
  };
  const onDisconnect = () => handlers.onDisconnect();
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onDisconnect);
  return {
    disconnect() {
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      try {
        port.disconnect();
      } catch {
        // already gone
      }
    },
  };
}

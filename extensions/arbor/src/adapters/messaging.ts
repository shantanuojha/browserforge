/**
 * Both ends of Arbor's request/response messaging bound to `browser.runtime`: `msg.<name>.send()`
 * for pages and `listenForMessages(router)` for the background.
 */
import { createMessageListener } from "@browserforge/shared";
import { browser } from "wxt/browser";
import { messages } from "../lib/messages";
import { bindMessages, isEnvelope, type MessageRouter, type Wire } from "../lib/messaging";

export const msg = bindMessages(messages, {
  send: (envelope) => browser.runtime.sendMessage(envelope),
});

/** Register `router` on `runtime.onMessage`; envelopes that are not ours are left to others. */
export function listenForMessages(router: MessageRouter): void {
  browser.runtime.onMessage.addListener(
    createMessageListener({
      accepts: isEnvelope,
      handle: (message, sender) => router.dispatch(message, sender),
      onError: (error): Wire => ({ ok: false, error: String(error) }),
    }),
  );
}

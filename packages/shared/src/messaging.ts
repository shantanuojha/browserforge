/**
 * Builds a `runtime.onMessage` listener from a type guard and an async handler, encoding the
 * one rule every extension gets wrong at least once: return `true` to keep the response channel
 * open while the handler is still running, and return nothing for messages that are not ours.
 *
 * Pure: the caller registers the returned listener with `browser.runtime.onMessage`.
 */

export type SendResponse = (response: unknown) => void;

export type RuntimeMessageListener = (
  raw: unknown,
  sender: unknown,
  sendResponse: SendResponse,
) => true | undefined;

export interface MessageListenerOptions<M> {
  /** Recognises the messages this listener owns. */
  accepts(value: unknown): value is M;
  /** Produces the response; a rejection is turned into `onError`'s response. */
  handle(message: M, sender: unknown): Promise<unknown> | unknown;
  /** Response for a rejected handler. Defaults to `undefined` (the caller sees no response). */
  onError?(error: unknown, message: M): unknown;
}

export function createMessageListener<M>(
  options: MessageListenerOptions<M>,
): RuntimeMessageListener {
  return (raw, sender, sendResponse) => {
    if (!options.accepts(raw)) return undefined;
    Promise.resolve()
      .then(() => options.handle(raw, sender))
      .then(sendResponse, (error: unknown) => sendResponse(options.onError?.(error, raw)));
    return true;
  };
}

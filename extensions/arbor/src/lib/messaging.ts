import { browser, type Browser } from "wxt/browser";

/**
 * Minimal typed request/response messaging over `browser.runtime.sendMessage`.
 *
 * `defineMessage<Req, Res>("name")` gives you a `send(req)` for pages and a definition the
 * background's `MessageRouter` can attach a handler to. Responses are wrapped so errors thrown
 * by the handler reach the caller as rejected promises.
 */

const TAG = "__arbor";

interface Envelope {
  [TAG]: string;
  payload: unknown;
}

type Wire = { ok: true; value: unknown } | { ok: false; error: string };

export interface MessageDef<Req, Res> {
  readonly name: string;
  send(req: Req): Promise<Res>;
  /** Type carrier; never assigned. */
  readonly _types?: { req: Req; res: Res };
}

function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[TAG] === "string"
  );
}

function isWire(value: unknown): value is Wire {
  return typeof value === "object" && value !== null && "ok" in value;
}

export function defineMessage<Req, Res>(name: string): MessageDef<Req, Res> {
  return {
    name,
    async send(req: Req): Promise<Res> {
      const envelope: Envelope = { [TAG]: name, payload: req };
      const raw: unknown = await browser.runtime.sendMessage(envelope);
      if (!isWire(raw)) throw new Error(`No response for message "${name}"`);
      if (!raw.ok) throw new Error(raw.error);
      return raw.value as Res;
    },
  };
}

export type Handler<Req, Res> = (
  req: Req,
  sender: Browser.runtime.MessageSender,
) => Promise<Res> | Res;

export class MessageRouter {
  private readonly handlers = new Map<string, Handler<unknown, unknown>>();
  private listening = false;

  on<Req, Res>(def: MessageDef<Req, Res>, handler: Handler<Req, Res>): this {
    this.handlers.set(def.name, handler as Handler<unknown, unknown>);
    return this;
  }

  /** Dispatch one raw message; exposed for tests. Returns undefined when not ours. */
  async dispatch(
    message: unknown,
    sender: Browser.runtime.MessageSender,
  ): Promise<Wire | undefined> {
    if (!isEnvelope(message)) return undefined;
    const handler = this.handlers.get(message[TAG]);
    if (!handler) return { ok: false, error: `Unknown message "${message[TAG]}"` };
    try {
      return { ok: true, value: await handler(message.payload, sender) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  listen(): void {
    if (this.listening) return;
    this.listening = true;
    browser.runtime.onMessage.addListener(
      (message: unknown, sender, sendResponse: (response: Wire) => void) => {
        if (!isEnvelope(message)) return false;
        void this.dispatch(message, sender).then((wire) => {
          if (wire) sendResponse(wire);
        });
        return true; // keep the channel open for the async response
      },
    );
  }
}

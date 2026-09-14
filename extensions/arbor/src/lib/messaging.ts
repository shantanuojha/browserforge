/**
 * Typed request/response messaging, transport-agnostic.
 *
 * `defineMessage<Req, Res>("name")` names a message and carries its types. `bindMessages` turns a
 * catalog of definitions into `send(req)` functions over a `MessageTransport` (the adapter
 * supplies `browser.runtime.sendMessage`); `MessageRouter` dispatches incoming envelopes to
 * handlers. Responses are wrapped so errors thrown by a handler reach the caller as rejections.
 *
 * Pure: no `browser.*`. `adapters/messaging.ts` binds both ends to the runtime.
 */
import { errorMessage } from "@browserforge/shared";

const TAG = "__arbor";

export interface Envelope {
  [TAG]: string;
  payload: unknown;
}

export type Wire = { ok: true; value: unknown } | { ok: false; error: string };

export interface MessageDef<Req, Res> {
  readonly name: string;
  /** Type carrier; never assigned. */
  readonly _types?: { req: Req; res: Res };
}

export function defineMessage<Req, Res>(name: string): MessageDef<Req, Res> {
  return { name };
}

export function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[TAG] === "string"
  );
}

export function isWire(value: unknown): value is Wire {
  return typeof value === "object" && value !== null && "ok" in value;
}

/** Wrap a request for the wire. */
export function envelopeFor<Req, Res>(def: MessageDef<Req, Res>, req: Req): Envelope {
  return { [TAG]: def.name, payload: req };
}

/** Unwrap a response; throws with the handler's message when it failed or never answered. */
export function unwrapResponse<Req, Res>(def: MessageDef<Req, Res>, raw: unknown): Res {
  if (!isWire(raw)) throw new Error(`No response for message "${def.name}"`);
  if (!raw.ok) throw new Error(raw.error);
  return raw.value as Res;
}

export interface MessageTransport {
  send(envelope: Envelope): Promise<unknown>;
}

export type BoundMessage<Req, Res> = MessageDef<Req, Res> & {
  send(req: Req): Promise<Res>;
};

type Catalog = Record<string, MessageDef<unknown, unknown>>;

export type BoundCatalog<T extends Catalog> = {
  [K in keyof T]: T[K] extends MessageDef<infer Req, infer Res> ? BoundMessage<Req, Res> : never;
};

/** Give every definition in `catalog` a `send` over `transport`. */
export function bindMessages<T extends Catalog>(
  catalog: T,
  transport: MessageTransport,
): BoundCatalog<T> {
  const bound: Record<string, BoundMessage<unknown, unknown>> = {};
  for (const [key, def] of Object.entries(catalog)) {
    bound[key] = {
      name: def.name,
      async send(req) {
        return unwrapResponse(def, await transport.send(envelopeFor(def, req)));
      },
    };
  }
  return bound as BoundCatalog<T>;
}

export type Handler<Req, Res> = (req: Req, sender: unknown) => Promise<Res> | Res;

export class MessageRouter {
  private readonly handlers = new Map<string, Handler<unknown, unknown>>();

  on<Req, Res>(def: MessageDef<Req, Res>, handler: Handler<Req, Res>): this {
    this.handlers.set(def.name, handler as Handler<unknown, unknown>);
    return this;
  }

  /** Dispatch one raw message. Returns undefined when it is not one of ours. */
  async dispatch(message: unknown, sender: unknown): Promise<Wire | undefined> {
    if (!isEnvelope(message)) return undefined;
    const handler = this.handlers.get(message[TAG]);
    if (!handler) return { ok: false, error: `Unknown message "${message[TAG]}"` };
    try {
      return { ok: true, value: await handler(message.payload, sender) };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  }
}

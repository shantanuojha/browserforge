import { describe, expect, it, vi } from "vitest";
import { createMessageListener } from "./messaging.js";

interface Ping {
  type: "ping";
}

const isPing = (value: unknown): value is Ping =>
  typeof value === "object" && value !== null && (value as { type?: unknown }).type === "ping";

/** Resolves with whatever the listener sends back. */
function deliver(listener: ReturnType<typeof createMessageListener>, raw: unknown) {
  return new Promise<{ kept: true | undefined; response: unknown }>((resolve) => {
    const kept = listener(raw, {}, (response) => resolve({ kept: true, response }));
    if (kept === undefined) resolve({ kept, response: undefined });
  });
}

describe("createMessageListener", () => {
  it("ignores messages the guard rejects", async () => {
    const handle = vi.fn();
    const listener = createMessageListener({ accepts: isPing, handle });
    const result = await deliver(listener, { type: "other" });
    expect(result.kept).toBeUndefined();
    expect(handle).not.toHaveBeenCalled();
  });

  it("keeps the channel open and sends the handler's result", async () => {
    const listener = createMessageListener({ accepts: isPing, handle: async () => "pong" });
    expect(await deliver(listener, { type: "ping" })).toEqual({ kept: true, response: "pong" });
  });

  it("maps a rejected handler through onError", async () => {
    const listener = createMessageListener({
      accepts: isPing,
      handle: () => Promise.reject(new Error("nope")),
      onError: (error) => ({ ok: false, error: String((error as Error).message) }),
    });
    expect((await deliver(listener, { type: "ping" })).response).toEqual({
      ok: false,
      error: "nope",
    });
  });
});

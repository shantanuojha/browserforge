/**
 * Test doubles for the licensing client, shared by every package that exercises Pro gating.
 * Import from `@browserforge/licensing/testing`; never from production code.
 */
import { vi } from "vitest";
import type { FetchLike, LicenseStorage } from "./types.js";

export interface MemoryStorage extends LicenseStorage {
  readonly data: Map<string, unknown>;
}

/** In-memory `chrome.storage.local` look-alike; values are cloned on write like the real thing. */
export function createMemoryStorage(initial: Record<string, unknown> = {}): MemoryStorage {
  const data = new Map<string, unknown>(Object.entries(initial));
  const toList = (keys: string | string[]) => (typeof keys === "string" ? [keys] : keys);
  return {
    data,
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const key of toList(keys)) if (data.has(key)) out[key] = data.get(key);
      return out;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
    async remove(keys) {
      for (const key of toList(keys)) data.delete(key);
    },
  };
}

export interface RecordedCall {
  readonly endpoint: string;
  readonly body: Record<string, string>;
}

export type Responder = (
  endpoint: string,
  body: Record<string, string>,
) => { status?: number; json?: unknown } | Error;

/** Builds an injectable `fetch` that records calls and answers via `responder`. */
export function createFakeFetch(responder: Responder) {
  const calls: RecordedCall[] = [];
  const fetchImpl = vi.fn<FetchLike>(async (input, init) => {
    const endpoint = input.slice(input.lastIndexOf("/") + 1);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
    calls.push({ endpoint, body });
    const answer = responder(endpoint, body);
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer.json ?? {}), {
      status: answer.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { fetch: fetchImpl, calls };
}

export const VARIANT_ID = 4242;
export const RAW_KEY = "38b1460a-5104-4067-a91d-77b872934d51";
export const INSTANCE_ID = "5bd6ff3b-9dd8-4fd2-9d7f-1ccb4a1ca2a1";

export interface LicenseBodyOptions {
  /** `meta.variant_id` in the answer; defaults to `VARIANT_ID`. */
  variantId?: number;
  /** `instance.name` in the answer. */
  instanceName?: string;
}

/** A successful `activate` answer for `RAW_KEY`. */
export function activatedBody(
  overrides: Record<string, unknown> = {},
  options: LicenseBodyOptions = {},
) {
  return {
    activated: true,
    error: null,
    license_key: {
      id: 1,
      status: "active",
      key: RAW_KEY,
      activation_limit: 3,
      activation_usage: 1,
      created_at: "2026-01-01T00:00:00.000000Z",
      expires_at: null,
    },
    instance: {
      id: INSTANCE_ID,
      name: options.instanceName ?? "arbor@chrome-abc123",
      created_at: "2026-01-01",
    },
    meta: {
      store_id: 7,
      product_id: 9,
      variant_id: options.variantId ?? VARIANT_ID,
      customer_email: "pat@example.com",
      customer_name: "Pat",
    },
    ...overrides,
  };
}

/** A successful `validate` answer for `RAW_KEY`. */
export function validBody(
  overrides: Record<string, unknown> = {},
  options: LicenseBodyOptions = {},
) {
  const base = activatedBody({}, options);
  return { ...base, activated: undefined, valid: true, ...overrides };
}

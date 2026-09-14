/**
 * Reads and writes the chunked rule set through a `SyncArea` port, so the logic can be tested
 * against an in-memory area and the background hands in `browser.storage.sync`.
 */

import { errorMessage, systemClock, type Clock } from "@browserforge/shared";
import { parseRules, type Rule } from "../rules/model";
import {
  SYNC_FORMAT_VERSION,
  SYNC_META_KEY,
  chunkIndexOf,
  chunkKey,
  chunkString,
  decodePayload,
  encodePayload,
  isChunkKey,
  type SyncMeta,
} from "./codec";

/** The subset of `browser.storage.sync` the store needs. */
export interface SyncArea {
  getAll(): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface SyncSnapshot {
  meta: SyncMeta;
  rules: Rule[];
  errors: string[];
}

export interface SyncStore {
  /** `null` when nothing is published or a write is still in flight (chunks missing). */
  read(): Promise<SyncSnapshot | null>;
  write(rules: readonly Rule[], origin: string): Promise<SyncMeta>;
  clear(): Promise<void>;
}

function isSyncMeta(value: unknown): value is SyncMeta {
  return (
    typeof value === "object" && value !== null && typeof (value as SyncMeta).chunks === "number"
  );
}

/** Chunk values in order, or null when any is missing (partial write in flight). */
function collectChunks(all: Record<string, unknown>, count: number): string[] | null {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const part = all[chunkKey(i)];
    if (typeof part !== "string") return null;
    parts.push(part);
  }
  return parts;
}

async function decodeSnapshot(meta: SyncMeta, parts: string[]): Promise<SyncSnapshot> {
  try {
    const text = await decodePayload(parts.join(""), meta.compressed === true);
    const parsed = parseRules(JSON.parse(text));
    return { meta, rules: parsed.rules, errors: parsed.errors };
  } catch (e) {
    return { meta, rules: [], errors: [errorMessage(e)] };
  }
}

export function createSyncStore(area: SyncArea, clock: Clock = systemClock): SyncStore {
  return {
    async read() {
      const all = await area.getAll();
      const meta = all[SYNC_META_KEY];
      if (!isSyncMeta(meta)) return null;
      const parts = collectChunks(all, meta.chunks);
      return parts ? decodeSnapshot(meta, parts) : null;
    },

    async write(rules, origin) {
      const { data, compressed } = await encodePayload(JSON.stringify(rules));
      const chunks = chunkString(data);
      const meta: SyncMeta = {
        v: SYNC_FORMAT_VERSION,
        updatedAt: clock(),
        chunks: chunks.length,
        bytes: data.length,
        origin,
        compressed,
      };
      const existing = await area.getAll();
      const stale = Object.keys(existing).filter(
        (key) => isChunkKey(key) && chunkIndexOf(key) >= chunks.length,
      );
      const payload: Record<string, unknown> = { [SYNC_META_KEY]: meta };
      chunks.forEach((chunk, i) => {
        payload[chunkKey(i)] = chunk;
      });
      await area.set(payload);
      if (stale.length > 0) await area.remove(stale);
      return meta;
    },

    async clear() {
      const all = await area.getAll();
      const keys = Object.keys(all).filter((key) => key === SYNC_META_KEY || isChunkKey(key));
      if (keys.length > 0) await area.remove(keys);
    },
  };
}

/** In-memory `SyncArea` for tests. */
export function createMemorySyncArea(initial: Record<string, unknown> = {}): SyncArea & {
  data: Map<string, unknown>;
} {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    async getAll() {
      return Object.fromEntries(data);
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
    async remove(keys) {
      for (const key of keys) data.delete(key);
    },
  };
}

/**
 * Pro: mirror rules into `browser.storage.sync`.
 *
 * sync has a per-item quota (8 KB including the key and JSON quoting) and a
 * 100 KB total, so the serialised rules are deflate-compressed, base64'd and
 * split into chunks under a manifest key:
 *
 *   reroute.sync.meta            { v, updatedAt, chunks, bytes, origin }
 *   reroute.sync.chunk.<n>       string
 */

import { browser } from "wxt/browser";
import { parseRules, type Rule } from "./rules/model";

export const SYNC_META_KEY = "reroute.sync.meta";
export const SYNC_CHUNK_PREFIX = "reroute.sync.chunk.";
/** Leaves headroom for the key name and JSON quoting under QUOTA_BYTES_PER_ITEM (8192). */
export const SYNC_CHUNK_SIZE = 7_000;
export const SYNC_FORMAT_VERSION = 1;

export interface SyncMeta {
  v: number;
  updatedAt: number;
  chunks: number;
  bytes: number;
  /** Random id of the writer, used to ignore our own echo. */
  origin: string;
  compressed: boolean;
}

export function chunkString(text: string, size = SYNC_CHUNK_SIZE): string[] {
  if (text.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipeThrough(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const readable = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(readable).arrayBuffer());
}

const canCompress = typeof CompressionStream !== "undefined";

/** Compresses when the platform supports it; the meta flag records which path was taken. */
export async function encodePayload(text: string): Promise<{ data: string; compressed: boolean }> {
  const raw = new TextEncoder().encode(text);
  if (!canCompress) return { data: bytesToBase64(raw), compressed: false };
  const packed = await pipeThrough(raw, new CompressionStream("deflate-raw"));
  return { data: bytesToBase64(packed), compressed: true };
}

export async function decodePayload(data: string, compressed: boolean): Promise<string> {
  const bytes = base64ToBytes(data);
  const raw = compressed ? await pipeThrough(bytes, new DecompressionStream("deflate-raw")) : bytes;
  return new TextDecoder().decode(raw);
}

export function newOrigin(): string {
  return Math.random().toString(36).slice(2, 10);
}

export async function writeRulesToSync(rules: readonly Rule[], origin: string): Promise<SyncMeta> {
  const text = JSON.stringify(rules);
  const { data, compressed } = await encodePayload(text);
  const chunks = chunkString(data);
  const meta: SyncMeta = {
    v: SYNC_FORMAT_VERSION,
    updatedAt: Date.now(),
    chunks: chunks.length,
    bytes: data.length,
    origin,
    compressed,
  };

  const existing = await browser.storage.sync.get(null);
  const stale = Object.keys(existing).filter(
    (k) =>
      k.startsWith(SYNC_CHUNK_PREFIX) && Number(k.slice(SYNC_CHUNK_PREFIX.length)) >= chunks.length,
  );
  const payload: Record<string, unknown> = { [SYNC_META_KEY]: meta };
  chunks.forEach((c, i) => {
    payload[`${SYNC_CHUNK_PREFIX}${i}`] = c;
  });
  await browser.storage.sync.set(payload);
  if (stale.length > 0) await browser.storage.sync.remove(stale);
  return meta;
}

export interface SyncSnapshot {
  meta: SyncMeta;
  rules: Rule[];
  errors: string[];
}

export async function readRulesFromSync(): Promise<SyncSnapshot | null> {
  const all = await browser.storage.sync.get(null);
  const meta = all[SYNC_META_KEY] as SyncMeta | undefined;
  if (!meta || typeof meta.chunks !== "number") return null;
  const parts: string[] = [];
  for (let i = 0; i < meta.chunks; i++) {
    const part = all[`${SYNC_CHUNK_PREFIX}${i}`];
    if (typeof part !== "string") return null; // partial write in flight
    parts.push(part);
  }
  try {
    const text = await decodePayload(parts.join(""), meta.compressed === true);
    const parsed = parseRules(JSON.parse(text));
    return { meta, rules: parsed.rules, errors: parsed.errors };
  } catch (e) {
    return { meta, rules: [], errors: [e instanceof Error ? e.message : String(e)] };
  }
}

export async function clearSync(): Promise<void> {
  const all = await browser.storage.sync.get(null);
  const keys = Object.keys(all).filter(
    (k) => k === SYNC_META_KEY || k.startsWith(SYNC_CHUNK_PREFIX),
  );
  if (keys.length > 0) await browser.storage.sync.remove(keys);
}

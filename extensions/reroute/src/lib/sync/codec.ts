/**
 * Wire format for Pro rule sync in `browser.storage.sync`.
 *
 * sync has a per-item quota (8 KB including the key and JSON quoting) and a
 * 100 KB total, so the serialised rules are deflate-compressed, base64'd and
 * split into chunks under a manifest key:
 *
 *   reroute.sync.meta            { v, updatedAt, chunks, bytes, origin, compressed }
 *   reroute.sync.chunk.<n>       string
 */

import { base64ToBytes, bytesToBase64 } from "@browserforge/shared";
import type { Rule } from "../rules/model";

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

export function chunkKey(index: number): string {
  return `${SYNC_CHUNK_PREFIX}${index}`;
}

export function isChunkKey(key: string): boolean {
  return key.startsWith(SYNC_CHUNK_PREFIX);
}

export function chunkIndexOf(key: string): number {
  return Number(key.slice(SYNC_CHUNK_PREFIX.length));
}

export function chunkString(text: string, size = SYNC_CHUNK_SIZE): string[] {
  if (text.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
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

/**
 * Rule set a device adopts when it joins sync: the remote set in its order,
 * followed by local rules whose id the remote does not have. Nothing on either
 * side is dropped, so enabling sync on a fresh device cannot wipe the others.
 */
export function mergeRulesOnJoin(remote: readonly Rule[], local: readonly Rule[]): Rule[] {
  const seen = new Set(remote.map((r) => r.id));
  return [...remote, ...local.filter((r) => !seen.has(r.id))];
}

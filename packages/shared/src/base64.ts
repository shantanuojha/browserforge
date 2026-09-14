/**
 * Base64 helpers over `btoa`/`atob` that work on UTF-8 text and raw bytes.
 * Decoding is lenient: it accepts the URL-safe alphabet, whitespace and missing padding.
 */

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  let normalized = text.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  while (normalized.length % 4 !== 0) normalized += "=";
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function utf8ToBase64(text: string): string {
  return bytesToBase64(utf8Encoder.encode(text));
}

export function base64ToUtf8(text: string): string {
  return utf8Decoder.decode(base64ToBytes(text));
}

/** Standard alphabet to the URL-safe one (RFC 4648 section 5), padding removed. */
export function toBase64Url(base64: string): string {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function utf8ToBase64Url(text: string): string {
  return toBase64Url(utf8ToBase64(text));
}

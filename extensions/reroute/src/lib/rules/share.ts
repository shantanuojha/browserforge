/**
 * Shareable rule-set links: `reroute://import#<base64url(JSON)>`.
 * Entirely client-side; there is no server. The payload is our own
 * RuleSetDocument, so importing goes through the same validation as files.
 */

import { parseRules, toRuleSetDocument, type ParsedRules, type Rule } from "./model";

export const SHARE_PREFIX = "reroute://import#";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64UrlEncode(text: string): string {
  const bytes = encoder.encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): string {
  let b64 = text.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  while (b64.length % 4 !== 0) b64 += "=";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return decoder.decode(bytes);
}

export function encodeShareLink(rules: readonly Rule[]): string {
  const doc = toRuleSetDocument(rules);
  delete doc.exportedAt;
  // Strip ids: the importer regenerates them, keeping the link shorter and collision-free.
  const compact = { ...doc, rules: doc.rules.map(({ id: _id, ...rest }) => rest) };
  return SHARE_PREFIX + base64UrlEncode(JSON.stringify(compact));
}

export function isShareLink(text: string): boolean {
  return text.trim().startsWith(SHARE_PREFIX);
}

export function decodeShareLink(text: string): ParsedRules {
  const trimmed = text.trim();
  if (!trimmed.startsWith(SHARE_PREFIX)) return { rules: [], errors: ["Not a reroute:// link"] };
  const payload = trimmed.slice(SHARE_PREFIX.length);
  let json: unknown;
  try {
    json = JSON.parse(base64UrlDecode(payload));
  } catch (e) {
    return { rules: [], errors: [`Could not decode link: ${e instanceof Error ? e.message : e}`] };
  }
  return parseRules(json);
}

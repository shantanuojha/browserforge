/**
 * Shareable rule-set links: `reroute://import#<base64url(JSON)>`.
 * Entirely client-side; there is no server. The payload is our own
 * RuleSetDocument, so importing goes through the same validation as files.
 */

import { base64ToUtf8, errorMessage, utf8ToBase64Url } from "@browserforge/shared";
import { parseRules, toRuleSetDocument, type ParsedRules, type Rule } from "./model";

export const SHARE_PREFIX = "reroute://import#";

export function encodeShareLink(rules: readonly Rule[]): string {
  const doc = toRuleSetDocument(rules);
  delete doc.exportedAt;
  // Strip ids: the importer regenerates them, keeping the link shorter and collision-free.
  const compact = { ...doc, rules: doc.rules.map(({ id: _id, ...rest }) => rest) };
  return SHARE_PREFIX + utf8ToBase64Url(JSON.stringify(compact));
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
    json = JSON.parse(base64ToUtf8(payload));
  } catch (e) {
    return { rules: [], errors: [`Could not decode link: ${errorMessage(e)}`] };
  }
  return parseRules(json);
}

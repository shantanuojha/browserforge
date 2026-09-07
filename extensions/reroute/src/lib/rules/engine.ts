/**
 * Pure rule engine. No browser APIs; everything here is unit-tested.
 *
 * Semantics follow Redirector so imports behave identically:
 *  - wildcard patterns are anchored and every `*` captures;
 *  - regex patterns match anywhere in the URL (case-insensitive);
 *  - the redirect target is the template with `$1..$9` replaced by the
 *    (transformed) capture groups; the URL itself is not spliced;
 *  - the first matching enabled rule wins; excludes veto a rule and the search
 *    continues with the next rule.
 */

import type { DnrResourceType, DnrRule } from "../dnr";
import { DNR_PRIORITY } from "../dnr";
import { RESOURCE_TYPES, type Rule, type Transform } from "./model";
import { isRE2Compatible } from "./re2";

export { checkRE2Compatible, isRE2Compatible } from "./re2";

// ---------------------------------------------------------------------------
// Pattern conversion
// ---------------------------------------------------------------------------

const REGEX_SPECIALS = /[-[\]{}()+?.,\\^$|#\s]/g;

/** Redirector-compatible wildcard conversion: escape everything, `*` -> `(.*)`, anchor. */
export function wildcardToRegex(pattern: string): string {
  const escaped = pattern.replace(REGEX_SPECIALS, "\\$&").replace(/\*/g, "(.*)");
  return `^${escaped}$`;
}

export function includeRegexSource(rule: Pick<Rule, "matchType" | "include">): string {
  return rule.matchType === "wildcard" ? wildcardToRegex(rule.include) : rule.include;
}

export function excludeRegexSources(rule: Pick<Rule, "matchType" | "exclude">): string[] {
  return rule.exclude
    .filter((e) => e.length > 0)
    .map((e) => (rule.matchType === "wildcard" ? wildcardToRegex(e) : e));
}

/** Number of capturing groups in a regex source (ignores `(?:`, lookarounds and escaped/classed parens). */
export function countCaptureGroups(source: string): number {
  let count = 0;
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "(") {
      if (source[i + 1] !== "?") count++;
      else if (source[i + 2] === "<" && source[i + 3] !== "=" && source[i + 3] !== "!") count++; // named group
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Regex cache
// ---------------------------------------------------------------------------

const MAX_CACHE = 512;
const regexCache = new Map<string, RegExp | null>();

export function getRegex(source: string): RegExp | null {
  const cached = regexCache.get(source);
  if (cached !== undefined) return cached;
  let re: RegExp | null;
  try {
    re = new RegExp(source, "i");
  } catch {
    re = null;
  }
  if (regexCache.size >= MAX_CACHE) regexCache.clear();
  regexCache.set(source, re);
  return re;
}

// ---------------------------------------------------------------------------
// Transforms and substitution
// ---------------------------------------------------------------------------

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

function base64Encode(text: string): string {
  const bytes = utf8Encoder.encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64Decode(text: string): string {
  // Accept URL-safe alphabet and missing padding.
  let normalized = text.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  while (normalized.length % 4 !== 0) normalized += "=";
  const bin = atob(normalized);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return utf8Decoder.decode(bytes);
}

/** Applies transforms in order. Throws on malformed input (bad %-escape, bad base64). */
export function applyTransforms(value: string, transforms: readonly Transform[]): string {
  let out = value;
  for (const t of transforms) {
    switch (t) {
      case "decodeURIComponent":
        out = decodeURIComponent(out);
        break;
      case "encodeURIComponent":
        out = encodeURIComponent(out);
        break;
      case "atob":
        out = base64Decode(out);
        break;
      case "btoa":
        out = base64Encode(out);
        break;
      case "lower":
        out = out.toLowerCase();
        break;
      case "upper":
        out = out.toUpperCase();
        break;
      default: {
        const never: never = t;
        throw new Error(`Unknown transform ${String(never)}`);
      }
    }
  }
  return out;
}

/** Replaces `$1`..`$9` in the template. Missing groups become "". */
export function substitute(template: string, groups: readonly (string | undefined)[]): string {
  return template.replace(/\$([1-9])/g, (_m, d: string) => groups[Number(d) - 1] ?? "");
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface MatchDetail {
  target: string;
  /** Raw capture groups ($1 is index 0). */
  groups: string[];
}

export function isValidAbsoluteUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol.length > 1;
  } catch {
    return false;
  }
}

/**
 * Returns the redirect target for `url` under `rule`, or null when the rule
 * does not apply (no match, excluded, disabled, transform failure, invalid
 * result URL, or result identical to the input).
 */
export function matchRuleDetailed(url: string, rule: Rule): MatchDetail | null {
  if (!rule.enabled) return null;
  const include = getRegex(includeRegexSource(rule));
  if (!include) return null;
  const m = include.exec(url);
  if (!m) return null;

  for (const src of excludeRegexSources(rule)) {
    const re = getRegex(src);
    if (re && re.test(url)) return null;
  }

  const groups = m.slice(1).map((g) => g ?? "");
  let transformed: string[];
  try {
    transformed = groups.map((g) => applyTransforms(g, rule.transforms));
  } catch {
    return null;
  }
  const target = substitute(rule.redirectTo, transformed);
  if (!isValidAbsoluteUrl(target)) return null;
  if (target === url) return null;
  return { target, groups };
}

export function matchRule(url: string, rule: Rule): string | null {
  return matchRuleDetailed(url, rule)?.target ?? null;
}

export interface FirstMatch {
  rule: Rule;
  index: number;
  target: string;
  groups: string[];
}

/** First enabled rule (in order) that produces a target. */
export function firstMatch(url: string, rules: readonly Rule[]): FirstMatch | null {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (!rule) continue;
    const detail = matchRuleDetailed(url, rule);
    if (detail) return { rule, index: i, target: detail.target, groups: detail.groups };
  }
  return null;
}

/** Whether a rule participates in top-level navigations (incl. history-state). */
export function appliesToNavigation(rule: Rule): boolean {
  if (rule.applyTo === "navigation") return true;
  return rule.resourceTypes.length === 0 || rule.resourceTypes.includes("main_frame");
}

/** Rule tester entry point: same as firstMatch but restricted to navigation-capable rules when asked. */
export function testUrl(
  url: string,
  rules: readonly Rule[],
  opts: { navigationOnly?: boolean } = {},
): FirstMatch | null {
  const candidates = opts.navigationOnly ? rules.filter(appliesToNavigation) : rules;
  return firstMatch(url, candidates);
}

// ---------------------------------------------------------------------------
// Loop protection
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_HOPS = 8;

function normalizeForLoop(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * `history` is the list of recent redirect targets for the tab (oldest first).
 * A redirect loops when it goes nowhere, revisits a recent target, or the tab
 * has already bounced `maxHops` times in the window the caller maintains.
 */
export function wouldLoop(
  fromUrl: string,
  toUrl: string,
  history: readonly string[],
  maxHops = DEFAULT_MAX_HOPS,
): boolean {
  const from = normalizeForLoop(fromUrl);
  const to = normalizeForLoop(toUrl);
  if (from === to) return true;
  if (history.length >= maxHops) return true;
  return history.some((h) => normalizeForLoop(h) === to);
}

// ---------------------------------------------------------------------------
// DNR compilation
// ---------------------------------------------------------------------------

export interface CompiledRules {
  dnrRules: DnrRule[];
  /** Rule ids that must be handled by the JS fallback (transforms, excludes, non-RE2 regex...). */
  jsOnlyRuleIds: string[];
  /** rule.id -> reason it is JS-only (for the UI). */
  jsOnlyReasons: Record<string, string>;
  /** rule.id -> DNR rule id, for the "what fired" log. */
  dnrIdByRuleId: Record<string, number>;
}

/** Wraps a regex so that DNR's "replace the first match" becomes "replace the whole URL". */
export function anchorForDNR(source: string): string {
  const startsAnchored = source.startsWith("^");
  const endsAnchored = /(^|[^\\])(\\\\)*\$$/.test(source);
  if (startsAnchored && endsAnchored) return source;
  const head = startsAnchored ? "" : "^.*?";
  const tail = endsAnchored ? "" : ".*$";
  return `${head}(?:${source})${tail}`;
}

/** `$1` -> `\1`. Returns null when the template cannot be expressed. */
export function toRegexSubstitution(template: string, groupCount: number): string | null {
  if (template.includes("\\")) return null;
  let bad = false;
  const out = template.replace(/\$([1-9])/g, (_m, d: string) => {
    if (Number(d) > groupCount) bad = true;
    return `\\${d}`;
  });
  return bad ? null : out;
}

/** Why a rule cannot be a DNR rule, or null if it can. */
export function dnrIneligibilityReason(rule: Rule): string | null {
  if (rule.transforms.length > 0) return "uses transforms";
  if (rule.exclude.length > 0) return "has exclude patterns";
  const source = includeRegexSource(rule);
  if (!isRE2Compatible(source)) return "regex is outside the RE2 subset";
  if (toRegexSubstitution(rule.redirectTo, countCaptureGroups(source)) === null)
    return "redirect target cannot be expressed as a regexSubstitution";
  return null;
}

export function dnrResourceTypes(rule: Rule): DnrResourceType[] {
  if (rule.applyTo === "navigation") return ["main_frame"];
  return rule.resourceTypes.length > 0 ? [...rule.resourceTypes] : [...RESOURCE_TYPES];
}

/**
 * Compiles enabled rules to DNR redirect rules. Earlier rules get a higher
 * priority so first-match-wins survives the translation. Disabled rules are
 * skipped entirely; ineligible rules are reported in `jsOnlyRuleIds`.
 */
export function compileToDNR(rules: readonly Rule[], idBase: number): CompiledRules {
  const enabled = rules.filter((r) => r.enabled);
  const dnrRules: DnrRule[] = [];
  const jsOnlyRuleIds: string[] = [];
  const jsOnlyReasons: Record<string, string> = {};
  const dnrIdByRuleId: Record<string, number> = {};

  enabled.forEach((rule, i) => {
    const reason = dnrIneligibilityReason(rule);
    if (reason) {
      jsOnlyRuleIds.push(rule.id);
      jsOnlyReasons[rule.id] = reason;
      return;
    }
    const source = includeRegexSource(rule);
    const substitution = toRegexSubstitution(rule.redirectTo, countCaptureGroups(source));
    if (substitution === null) return; // unreachable: covered by dnrIneligibilityReason
    const id = idBase + i;
    dnrIdByRuleId[rule.id] = id;
    dnrRules.push({
      id,
      priority: DNR_PRIORITY.userRuleBase + (enabled.length - 1 - i),
      condition: {
        regexFilter: anchorForDNR(source),
        resourceTypes: dnrResourceTypes(rule),
        isUrlFilterCaseSensitive: false,
      },
      action: { type: "redirect", redirect: { regexSubstitution: substitution } },
    });
  });

  return { dnrRules, jsOnlyRuleIds, jsOnlyReasons, dnrIdByRuleId };
}

/** Per-site allowlist -> high-priority allow rules. Patterns may be `host`, `*.host`, `*host`. */
export function allowlistToDNR(patterns: readonly string[], idBase: number): DnrRule[] {
  const domains = new Set<string>();
  for (const raw of patterns) {
    const host = raw
      .trim()
      .toLowerCase()
      .replace(/^\*\.?/, "")
      .replace(/^\.+|\.+$/g, "");
    if (host) domains.add(host);
  }
  if (domains.size === 0) return [];
  // requestDomains matches the domain and all its subdomains, which covers every pattern form.
  return [
    {
      id: idBase,
      priority: DNR_PRIORITY.siteAllow,
      condition: { requestDomains: [...domains], resourceTypes: [...RESOURCE_TYPES] },
      action: { type: "allow" },
    },
  ];
}

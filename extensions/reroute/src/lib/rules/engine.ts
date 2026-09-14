/**
 * Pure rule engine: pattern conversion, matching and loop protection. No browser APIs.
 * Compilation to declarativeNetRequest lives in `./dnr-compiler`.
 *
 * Semantics follow Redirector so imports behave identically:
 *  - wildcard patterns are anchored and every `*` captures;
 *  - regex patterns match anywhere in the URL (case-insensitive);
 *  - the redirect target is the template with `$1..$9` replaced by the
 *    (transformed) capture groups; the URL itself is not spliced;
 *  - the first matching enabled rule wins; excludes veto a rule and the search
 *    continues with the next rule.
 */

import { base64ToUtf8, utf8ToBase64 } from "@browserforge/shared";
import type { Rule, Transform } from "./model";

export { checkRE2Compatible, isRE2Compatible } from "./re2";

// ---------------------------------------------------------------------------
// Pattern conversion
// ---------------------------------------------------------------------------

const REGEX_SPECIALS = /[-[\]{}()+?.,\\^$|#\s]/g;

/**
 * Redirector-compatible wildcard conversion: escape everything, `*` -> `(.*?)`, anchor.
 * The captures are lazy exactly as in Redirector, so with several `*` the
 * earlier ones take the shortest split: two wildcards over `a/b/c` give `a` and `b/c`.
 */
export function wildcardToRegex(pattern: string): string {
  const escaped = pattern.replace(REGEX_SPECIALS, "\\$&").replace(/\*/g, "(.*?)");
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

/** True when the `(` at `i` opens a capturing group (`(x)` or a named `(?<name>x)`). */
function opensCaptureGroup(source: string, i: number): boolean {
  if (source[i + 1] !== "?") return true;
  return source[i + 2] === "<" && source[i + 3] !== "=" && source[i + 3] !== "!";
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
    else if (ch === "(" && opensCaptureGroup(source, i)) count++;
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

const TRANSFORM_FUNCTIONS: Readonly<Record<Transform, (value: string) => string>> = {
  decodeURIComponent: (value) => decodeURIComponent(value),
  encodeURIComponent: (value) => encodeURIComponent(value),
  atob: base64ToUtf8,
  btoa: utf8ToBase64,
  lower: (value) => value.toLowerCase(),
  upper: (value) => value.toUpperCase(),
};

/** Applies transforms in order. Throws on malformed input (bad %-escape, bad base64). */
export function applyTransforms(value: string, transforms: readonly Transform[]): string {
  return transforms.reduce((out, transform) => TRANSFORM_FUNCTIONS[transform](out), value);
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
    // Neither tabs.update nor a DNR redirect will navigate to a javascript: URL.
    return u.protocol.length > 1 && u.protocol !== "javascript:";
  } catch {
    return false;
  }
}

function isExcluded(url: string, rule: Rule): boolean {
  return excludeRegexSources(rule).some((src) => getRegex(src)?.test(url) === true);
}

/** Transformed captures, or null when a transform rejects its input. */
function transformGroups(groups: readonly string[], rule: Rule): string[] | null {
  try {
    return groups.map((g) => applyTransforms(g, rule.transforms));
  } catch {
    return null;
  }
}

/**
 * Returns the redirect target for `url` under `rule`, or null when the rule
 * does not apply (no match, excluded, disabled, transform failure, invalid
 * result URL, or result identical to the input).
 */
export function matchRuleDetailed(url: string, rule: Rule): MatchDetail | null {
  if (!rule.enabled) return null;
  const match = getRegex(includeRegexSource(rule))?.exec(url);
  if (!match || isExcluded(url, rule)) return null;

  const groups = match.slice(1).map((g) => g ?? "");
  const transformed = transformGroups(groups, rule);
  if (!transformed) return null;
  const target = substitute(rule.redirectTo, transformed);
  if (!isValidAbsoluteUrl(target) || target === url) return null;
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

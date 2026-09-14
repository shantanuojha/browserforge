/**
 * JS-side evaluator for the static `removeParams` ruleset. Used by
 * "Copy clean link" and the popup's "Clean & copy current URL", so the copied
 * link matches what the network layer would have produced for a navigation.
 *
 * Semantics mirror DNR for the rule shapes we generate: `allow` at a priority
 * at or above a redirect rule suppresses it; of the remaining removeParams
 * rules only the highest-priority one is applied (Chrome picks a single rule
 * per request and does not fall through when it changes nothing, which is why
 * the generator nests parameters into the more specific rule). Equal-priority
 * ties, which the generator avoids for nested providers, are unioned here.
 */

import { isSameOrSubdomain } from "@browserforge/shared";
import type { DnrRule } from "../dnr";

const regexCache = new Map<string, RegExp | null>();

function regexFor(source: string): RegExp | null {
  const cached = regexCache.get(source);
  if (cached !== undefined) return cached;
  let re: RegExp | null;
  try {
    re = new RegExp(source, "i");
  } catch {
    re = null;
  }
  regexCache.set(source, re);
  return re;
}

export function conditionMatches(rule: DnrRule, url: string, host: string): boolean {
  const c = rule.condition;
  if (c.resourceTypes && !c.resourceTypes.includes("main_frame")) return false;
  if (c.requestDomains && !c.requestDomains.some((d) => isSameOrSubdomain(host, d))) return false;
  if (c.excludedRequestDomains?.some((d) => isSameOrSubdomain(host, d))) return false;
  if (c.regexFilter) return regexFor(c.regexFilter)?.test(url) === true;
  return true;
}

export interface CleanResult {
  url: string;
  removed: string[];
  changed: boolean;
}

const unchanged = (url: string): CleanResult => ({ url, removed: [], changed: false });

/** `a+b` and `%2F` style encodings both name the same parameter; fall back to the raw key. */
function decodeQueryKey(rawKey: string): string {
  try {
    return decodeURIComponent(rawKey.replace(/\+/g, " "));
  } catch {
    return rawKey;
  }
}

function keyOf(part: string): string {
  const eq = part.indexOf("=");
  return eq === -1 ? part : part.slice(0, eq);
}

/** Removes query keys from the raw query string without re-encoding the survivors. */
export function removeQueryKeys(url: string, keys: ReadonlySet<string>): CleanResult {
  const qIndex = url.indexOf("?");
  if (qIndex === -1) return unchanged(url);
  const hashIndex = url.indexOf("#", qIndex);
  const query = hashIndex === -1 ? url.slice(qIndex + 1) : url.slice(qIndex + 1, hashIndex);
  const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
  if (query.length === 0) return unchanged(url);

  const removed: string[] = [];
  const kept: string[] = [];
  for (const part of query.split("&")) {
    if (part.length === 0) continue;
    const rawKey = keyOf(part);
    const key = decodeQueryKey(rawKey);
    if (keys.has(key) || keys.has(rawKey)) removed.push(key);
    else kept.push(part);
  }
  if (removed.length === 0) return unchanged(url);
  const base = url.slice(0, qIndex);
  const next = kept.length > 0 ? `${base}?${kept.join("&")}${hash}` : `${base}${hash}`;
  return { url: next, removed, changed: true };
}

/** Lower-cased hostname of an http(s) URL that has a query string; null otherwise. */
function cleanableHost(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.search) return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

const priorityOf = (rule: DnrRule): number => rule.priority ?? 1;
const removeParamsOf = (rule: DnrRule): readonly string[] | undefined =>
  rule.action.redirect?.transform?.queryTransform?.removeParams;

/** Parameter names the matching rules would strip from `url`, applying DNR's precedence. */
function paramsToRemove(rules: readonly DnrRule[], url: string, host: string): Set<string> {
  let highestAllow = -Infinity;
  const removers: DnrRule[] = [];
  for (const rule of rules) {
    if (!conditionMatches(rule, url, host)) continue;
    if (rule.action.type === "allow") highestAllow = Math.max(highestAllow, priorityOf(rule));
    else if (removeParamsOf(rule)) removers.push(rule);
  }
  const eligible = removers.filter((rule) => priorityOf(rule) > highestAllow);
  const top = Math.max(...eligible.map(priorityOf));
  const keys = new Set<string>();
  for (const rule of eligible) {
    if (priorityOf(rule) === top) for (const key of removeParamsOf(rule) ?? []) keys.add(key);
  }
  return keys;
}

/** Applies the tracking-parameter ruleset to a single URL. */
export function cleanUrl(url: string, rules: readonly DnrRule[]): CleanResult {
  const host = cleanableHost(url);
  if (host === null) return unchanged(url);
  const keys = paramsToRemove(rules, url, host);
  return keys.size === 0 ? unchanged(url) : removeQueryKeys(url, keys);
}

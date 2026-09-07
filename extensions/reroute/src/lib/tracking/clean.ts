/**
 * JS-side evaluator for the static `removeParams` ruleset. Used by
 * "Copy clean link" and the popup's "Clean & copy current URL", so the copied
 * link matches what the network layer would have produced for a navigation.
 *
 * Semantics mirror DNR for the rule shapes we generate: the highest-priority
 * matching rule wins; `allow` beats `redirect` at equal priority; because every
 * redirect re-enters matching, all applicable removeParams rules end up applied.
 */

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

function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith("." + domain);
}

export function conditionMatches(rule: DnrRule, url: string, host: string): boolean {
  const c = rule.condition;
  if (c.resourceTypes && !c.resourceTypes.includes("main_frame")) return false;
  if (c.requestDomains && !c.requestDomains.some((d) => domainMatches(host, d))) return false;
  if (c.excludedRequestDomains && c.excludedRequestDomains.some((d) => domainMatches(host, d)))
    return false;
  if (c.regexFilter) {
    const re = regexFor(c.regexFilter);
    if (!re || !re.test(url)) return false;
  }
  return true;
}

export interface CleanResult {
  url: string;
  removed: string[];
  changed: boolean;
}

/** Removes query keys from the raw query string without re-encoding the survivors. */
export function removeQueryKeys(url: string, keys: ReadonlySet<string>): CleanResult {
  const qIndex = url.indexOf("?");
  if (qIndex === -1) return { url, removed: [], changed: false };
  const hashIndex = url.indexOf("#", qIndex);
  const query = hashIndex === -1 ? url.slice(qIndex + 1) : url.slice(qIndex + 1, hashIndex);
  const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
  if (query.length === 0) return { url, removed: [], changed: false };

  const removed: string[] = [];
  const kept: string[] = [];
  for (const part of query.split("&")) {
    if (part.length === 0) continue;
    const eq = part.indexOf("=");
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, " "));
    } catch {
      // keep raw key
    }
    if (keys.has(key) || keys.has(rawKey)) removed.push(key);
    else kept.push(part);
  }
  if (removed.length === 0) return { url, removed: [], changed: false };
  const base = url.slice(0, qIndex);
  const next = kept.length > 0 ? `${base}?${kept.join("&")}${hash}` : `${base}${hash}`;
  return { url: next, removed, changed: true };
}

/** Applies the tracking-parameter ruleset to a single URL. */
export function cleanUrl(url: string, rules: readonly DnrRule[]): CleanResult {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:")
      return { url, removed: [], changed: false };
    if (!u.search) return { url, removed: [], changed: false };
    host = u.hostname.toLowerCase();
  } catch {
    return { url, removed: [], changed: false };
  }

  let maxAllow = -Infinity;
  const removers: DnrRule[] = [];
  for (const rule of rules) {
    if (!conditionMatches(rule, url, host)) continue;
    const priority = rule.priority ?? 1;
    if (rule.action.type === "allow") maxAllow = Math.max(maxAllow, priority);
    else if (rule.action.redirect?.transform?.queryTransform?.removeParams) removers.push(rule);
  }

  const keys = new Set<string>();
  for (const rule of removers) {
    if ((rule.priority ?? 1) <= maxAllow) continue;
    for (const k of rule.action.redirect!.transform!.queryTransform!.removeParams!) keys.add(k);
  }
  if (keys.size === 0) return { url, removed: [], changed: false };
  return removeQueryKeys(url, keys);
}

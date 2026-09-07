import { hostMatchesAny, normalizeHost, siteOf } from "@browserforge/shared";
import type { CleanupTrigger, ListEntry, ListType } from "./settings.js";

/**
 * Pure cleanup planner. No browser APIs; everything it needs is passed in.
 *
 * Rules, in priority order, for every cookie domain of a cookie store:
 *  1. A domain whose site (per `siteOf`) matches the site of any tab open in the
 *     same store is kept ("open-tab"). Parent and sub-domains count as the same site.
 *  2. Domains matching a whitelist pattern are kept ("whitelisted").
 *  3. Domains matching a greylist pattern are kept ("greylisted") unless
 *     `greyExpiredAtRestart` is true, in which case they are cleaned ("grey-expired").
 *  4. Everything else is cleaned ("unlisted"), except during a "startup" run with
 *     `startupScope: "grey-only"`, where unlisted domains are left alone
 *     ("startup-grey-only") so that a restart only expires the greylist.
 *
 * Tabs whose URL is not http(s) (file://, chrome://, about:, extension pages) are ignored.
 * Cookie domains may carry a leading dot (`.example.com`); they are normalised first.
 */

export type StartupScope = "grey-only" | "full";

export interface PlannerInput {
  /** storeId -> tab URLs (or bare hostnames) open in that cookie store. */
  openTabHosts: Readonly<Record<string, readonly string[]>>;
  /** storeId -> cookie domains present in that store (leading dots allowed). */
  cookieDomains: Readonly<Record<string, readonly string[]>>;
  lists: readonly ListEntry[];
  /** When true, greylisted domains lose their protection (browser restarted / explicit full clean). */
  greyExpiredAtRestart: boolean;
  trigger: CleanupTrigger;
  /** Only consulted when `trigger` is "startup". Defaults to "grey-only". */
  startupScope?: StartupScope;
}

export type KeepReason = "open-tab" | "whitelisted" | "greylisted" | "startup-grey-only";
export type CleanReason = "unlisted" | "grey-expired";
export type PlanReason = KeepReason | CleanReason;

export interface StorePlan {
  storeId: string;
  cleanDomains: string[];
  keepDomains: string[];
  reasons: Record<string, PlanReason>;
}

export interface CleanupPlan {
  trigger: CleanupTrigger;
  stores: StorePlan[];
}

const CLEAN_REASONS: ReadonlySet<PlanReason> = new Set<PlanReason>(["unlisted", "grey-expired"]);

export function isCleanReason(reason: PlanReason): reason is CleanReason {
  return CLEAN_REASONS.has(reason);
}

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;

/** True for IPv4 literals and (bracketed or bare) IPv6 literals. */
export function isIpHost(host: string): boolean {
  const h = normalizeHost(host);
  if (IPV4.test(h)) return true;
  if (h.startsWith("[") && h.endsWith("]")) return true;
  return h.includes(":");
}

/** Strip a leading dot and lowercase; `.Example.com` -> `example.com`. */
export function normalizeCookieDomain(domain: string): string {
  return normalizeHost(domain);
}

const NON_WEB_SCHEMES =
  /^(about|chrome|chrome-extension|moz-extension|edge|file|data|blob|javascript|view-source|devtools|opera|vivaldi|brave|safari-extension|safari-web-extension|ms-browser-extension):/i;

/**
 * Hostname of a tab URL, or null for tabs that cannot own cookies (file://, chrome://, about:...).
 * Also accepts a bare hostname (optionally with a port) for convenience.
 */
export function hostFromTabUrl(urlOrHost: string | undefined | null): string | null {
  if (!urlOrHost) return null;
  const raw = urlOrHost.trim();
  if (!raw) return null;
  if (NON_WEB_SCHEMES.test(raw)) return null;
  if (raw.includes("://")) {
    try {
      const url = new URL(raw);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      const host = normalizeHost(url.hostname);
      return host || null;
    } catch {
      return null;
    }
  }
  // Bare host, maybe with a port: "localhost:3000", "[::1]:8080", "example.com".
  const bracketed = /^(\[[^\]]+\])(?::\d+)?$/.exec(raw);
  if (bracketed?.[1]) return normalizeHost(bracketed[1]) || null;
  const host = normalizeHost(raw.replace(/:\d+$/, ""));
  if (!host || /[\s/]/.test(host)) return null;
  return host;
}

/**
 * Grouping key used for the "open tab" rule. IP literals and single-label hosts
 * (localhost) only match themselves; everything else collapses to `siteOf`.
 */
export function siteKey(host: string): string {
  const h = normalizeHost(host);
  if (!h) return h;
  if (isIpHost(h) || !h.includes(".")) return h;
  return siteOf(h);
}

export function sameSite(a: string, b: string): boolean {
  const ka = siteKey(a);
  const kb = siteKey(b);
  return ka !== "" && ka === kb;
}

function entriesForStore(lists: readonly ListEntry[], storeId: string): ListEntry[] {
  return lists.filter((entry) => entry.storeId === undefined || entry.storeId === storeId);
}

/**
 * Which list (if any) a cookie domain belongs to in the given store. Whitelist wins
 * over greylist when both match.
 */
export function listTypeFor(
  domain: string,
  storeId: string,
  lists: readonly ListEntry[],
): ListType | null {
  const applicable = entriesForStore(lists, storeId);
  const white = applicable.filter((e) => e.listType === "white").map((e) => e.pattern);
  if (hostMatchesAny(domain, white)) return "white";
  const grey = applicable.filter((e) => e.listType === "grey").map((e) => e.pattern);
  if (hostMatchesAny(domain, grey)) return "grey";
  return null;
}

/**
 * List status for a *site* the user is looking at (popup / badge). Matches the host
 * itself or its site key so that `*example.com` and `example.com` both count for
 * `www.example.com`. Approximate by design: individual cookie domains are what the
 * planner actually evaluates.
 */
export function classifyHost(
  host: string,
  storeId: string,
  lists: readonly ListEntry[],
): ListType | null {
  const h = normalizeHost(host);
  if (!h) return null;
  const direct = listTypeFor(h, storeId, lists);
  const site = siteKey(h);
  const viaSite = site !== h ? listTypeFor(site, storeId, lists) : null;
  if (direct === "white" || viaSite === "white") return "white";
  if (direct === "grey" || viaSite === "grey") return "grey";
  return null;
}

/** Pattern to add when the user whitelists/greylists the site they are on. */
export function suggestedPattern(host: string): string {
  const h = normalizeHost(host);
  if (isIpHost(h) || !h.includes(".")) return h;
  return `*${siteOf(h)}`;
}

/** Cookie domains (already normalised or not) that belong to the same site as `host`. */
export function domainsForSite(cookieDomains: readonly string[], host: string): string[] {
  const out = new Set<string>();
  for (const raw of cookieDomains) {
    const d = normalizeCookieDomain(raw);
    if (d && sameSite(d, host)) out.add(d);
  }
  return [...out].sort();
}

export interface StorePlanOptions {
  greyExpiredAtRestart: boolean;
  trigger: CleanupTrigger;
  startupScope?: StartupScope;
}

export function planStore(
  storeId: string,
  openTabUrls: readonly string[],
  cookieDomains: readonly string[],
  lists: readonly ListEntry[],
  options: StorePlanOptions,
): StorePlan {
  const openSites = new Set<string>();
  for (const url of openTabUrls) {
    const host = hostFromTabUrl(url);
    if (host) openSites.add(siteKey(host));
  }

  const startupScope = options.startupScope ?? "grey-only";
  const greyOnlyStartup = options.trigger === "startup" && startupScope === "grey-only";

  const reasons: Record<string, PlanReason> = {};
  const seen = new Set<string>();
  for (const raw of cookieDomains) {
    const domain = normalizeCookieDomain(raw);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);

    if (openSites.has(siteKey(domain))) {
      reasons[domain] = "open-tab";
      continue;
    }
    const listType = listTypeFor(domain, storeId, lists);
    if (listType === "white") {
      reasons[domain] = "whitelisted";
      continue;
    }
    if (listType === "grey") {
      reasons[domain] = options.greyExpiredAtRestart ? "grey-expired" : "greylisted";
      continue;
    }
    reasons[domain] = greyOnlyStartup ? "startup-grey-only" : "unlisted";
  }

  const cleanDomains: string[] = [];
  const keepDomains: string[] = [];
  for (const [domain, reason] of Object.entries(reasons)) {
    (isCleanReason(reason) ? cleanDomains : keepDomains).push(domain);
  }
  cleanDomains.sort();
  keepDomains.sort();
  return { storeId, cleanDomains, keepDomains, reasons };
}

export function planCleanup(input: PlannerInput): CleanupPlan {
  const storeIds = new Set<string>([
    ...Object.keys(input.cookieDomains),
    ...Object.keys(input.openTabHosts),
  ]);
  const options: StorePlanOptions = {
    greyExpiredAtRestart: input.greyExpiredAtRestart,
    trigger: input.trigger,
    ...(input.startupScope ? { startupScope: input.startupScope } : {}),
  };
  const stores = [...storeIds]
    .sort()
    .map((storeId) =>
      planStore(
        storeId,
        input.openTabHosts[storeId] ?? [],
        input.cookieDomains[storeId] ?? [],
        input.lists,
        options,
      ),
    );
  return { trigger: input.trigger, stores };
}

/** Flattened view for logs and UI. */
export function summarizePlan(plan: CleanupPlan): {
  cleanDomains: string[];
  keepDomains: string[];
} {
  const clean = new Set<string>();
  const keep = new Set<string>();
  for (const store of plan.stores) {
    store.cleanDomains.forEach((d) => clean.add(d));
    store.keepDomains.forEach((d) => keep.add(d));
  }
  return { cleanDomains: [...clean].sort(), keepDomains: [...keep].sort() };
}

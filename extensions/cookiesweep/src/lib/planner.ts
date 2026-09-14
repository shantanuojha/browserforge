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

/** Firefox Reader View: `about:reader?url=<encoded article URL>`. The tab still is that site. */
const READER_VIEW = /^about:reader\?/i;

/** Hostname of an absolute http(s) URL; null for other schemes or unparsable input. */
function hostOfWebUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return normalizeHost(url.hostname) || null;
  } catch {
    return null;
  }
}

/** Bare host, maybe with a port: "localhost:3000", "[::1]:8080", "example.com". */
function hostOfBareInput(raw: string): string | null {
  const bracketed = /^(\[[^\]]+\])(?::\d+)?$/.exec(raw);
  if (bracketed?.[1]) return normalizeHost(bracketed[1]) || null;
  const host = normalizeHost(raw.replace(/:\d+$/, ""));
  if (!host || /[\s/]/.test(host)) return null;
  return host;
}

/**
 * Hostname of a tab URL, or null for tabs that cannot own cookies (file://, chrome://, about:...).
 * Also accepts a bare hostname (optionally with a port) for convenience.
 */
export function hostFromTabUrl(urlOrHost: string | undefined | null): string | null {
  const raw = urlOrHost?.trim();
  if (!raw) return null;
  if (READER_VIEW.test(raw)) {
    const inner = new URLSearchParams(raw.slice(raw.indexOf("?") + 1)).get("url");
    return inner ? hostFromTabUrl(inner) : null;
  }
  if (NON_WEB_SCHEMES.test(raw)) return null;
  return raw.includes("://") ? hostOfWebUrl(raw) : hostOfBareInput(raw);
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

/** What one cookie store looks like at planning time. */
export interface StoreSnapshot {
  storeId: string;
  /** Tab URLs (or bare hostnames) open in this store. */
  openTabUrls: readonly string[];
  /** Cookie domains present in this store (leading dots allowed). */
  cookieDomains: readonly string[];
}

/** Site keys of every tab in the snapshot that can own cookies. */
function openSiteKeys(openTabUrls: readonly string[]): Set<string> {
  const sites = new Set<string>();
  for (const url of openTabUrls) {
    const host = hostFromTabUrl(url);
    if (host) sites.add(siteKey(host));
  }
  return sites;
}

/** Unique, normalised cookie domains in first-seen order. */
function uniqueCookieDomains(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const value of raw) {
    const domain = normalizeCookieDomain(value);
    if (domain) seen.add(domain);
  }
  return [...seen];
}

interface Verdict {
  openSites: ReadonlySet<string>;
  storeId: string;
  lists: readonly ListEntry[];
  greyExpired: boolean;
  /** A "startup" run that only expires the greylist leaves unlisted domains alone. */
  greyOnlyStartup: boolean;
}

/** The planner's rules, in priority order (see the module comment). */
function reasonFor(domain: string, verdict: Verdict): PlanReason {
  if (verdict.openSites.has(siteKey(domain))) return "open-tab";
  const listType = listTypeFor(domain, verdict.storeId, verdict.lists);
  if (listType === "white") return "whitelisted";
  if (listType === "grey") return verdict.greyExpired ? "grey-expired" : "greylisted";
  return verdict.greyOnlyStartup ? "startup-grey-only" : "unlisted";
}

export function planStore(
  store: StoreSnapshot,
  lists: readonly ListEntry[],
  options: StorePlanOptions,
): StorePlan {
  const startupScope = options.startupScope ?? "grey-only";
  const verdict: Verdict = {
    openSites: openSiteKeys(store.openTabUrls),
    storeId: store.storeId,
    lists,
    greyExpired: options.greyExpiredAtRestart,
    greyOnlyStartup: options.trigger === "startup" && startupScope === "grey-only",
  };

  const reasons: Record<string, PlanReason> = {};
  for (const domain of uniqueCookieDomains(store.cookieDomains)) {
    reasons[domain] = reasonFor(domain, verdict);
  }

  const cleanDomains: string[] = [];
  const keepDomains: string[] = [];
  for (const [domain, reason] of Object.entries(reasons)) {
    (isCleanReason(reason) ? cleanDomains : keepDomains).push(domain);
  }
  cleanDomains.sort();
  keepDomains.sort();
  return { storeId: store.storeId, cleanDomains, keepDomains, reasons };
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
  const stores = [...storeIds].sort().map((storeId) =>
    planStore(
      {
        storeId,
        openTabUrls: input.openTabHosts[storeId] ?? [],
        cookieDomains: input.cookieDomains[storeId] ?? [],
      },
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

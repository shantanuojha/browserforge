import { normalizeHost, siteOf } from "@browserforge/shared";
import {
  isIpHost,
  normalizeCookieDomain,
  siteKey,
  type CleanupPlan,
  type StorePlan,
} from "./planner.js";

/**
 * Executes a cleanup plan against a minimal, injectable subset of the extension
 * API so it can be unit-tested with a hand-rolled fake.
 *
 * Browser differences handled here:
 *  - Chrome 119+ / Firefox 100+: partitioned (CHIPS) cookies are only returned when
 *    `partitionKey` is passed to `cookies.getAll`; `{ partitionKey: {} }` returns every
 *    partition. Older browsers reject the property, so the call is wrapped in try/catch.
 *  - Chrome 74+: `browsingData.remove({ origins })`. Firefox has no `origins` filter but
 *    supports `hostnames` for cookies/localStorage/indexedDB/serviceWorkers and rejects
 *    unknown data types such as `cacheStorage`, so a second attempt uses the Firefox shape.
 */

export interface ExecutorPartitionKey {
  topLevelSite?: string;
  hasCrossSiteAncestor?: boolean;
}

export interface ExecutorCookie {
  name: string;
  domain: string;
  path: string;
  secure: boolean;
  storeId: string;
  partitionKey?: ExecutorPartitionKey;
}

export interface CookiesGetAllDetails {
  storeId?: string;
  domain?: string;
  partitionKey?: ExecutorPartitionKey;
}

export interface CookiesRemoveDetails {
  url: string;
  name: string;
  storeId?: string;
  partitionKey?: ExecutorPartitionKey;
}

export interface BrowsingDataRemovalOptions {
  origins?: string[];
  hostnames?: string[];
}

export type BrowsingDataTypes = Record<string, boolean>;

export interface ExecutorApi {
  cookies: {
    getAll(details: CookiesGetAllDetails): Promise<ExecutorCookie[]>;
    remove(details: CookiesRemoveDetails): Promise<unknown>;
  };
  browsingData?: {
    remove(options: BrowsingDataRemovalOptions, dataTypes: BrowsingDataTypes): Promise<void>;
  };
}

export interface ExecuteOptions {
  cleanSiteData: boolean;
  /** Extra hostnames whose site data should be cleared too (e.g. the tab's actual host). */
  extraHosts?: readonly string[];
}

export interface ExecuteResult {
  storeId: string;
  domains: string[];
  cookiesRemoved: number;
  cookiesFailed: number;
  /** Number of domains whose site data was cleared (0 when disabled or unsupported). */
  siteDataDomains: number;
  siteDataFailed: boolean;
  /** Which browsingData shape succeeded, for diagnostics. */
  siteDataMode: "origins" | "hostnames" | "none";
}

export const CHROME_SITE_DATA_TYPES: BrowsingDataTypes = {
  localStorage: true,
  indexedDB: true,
  cacheStorage: true,
  serviceWorkers: true,
};

/** Firefox rejects unknown data types (`cacheStorage`), so only send what it knows. */
export const FIREFOX_SITE_DATA_TYPES: BrowsingDataTypes = {
  localStorage: true,
  indexedDB: true,
  serviceWorkers: true,
};

/**
 * The domain a cookie should be planned under. Partitioned cookies belong to the
 * top-level site they were set in, so `widget.com` embedded in `news.com` is treated
 * as `news.com` data: it survives while news.com is open and goes when it closes.
 */
export function cookiePlanningDomain(cookie: ExecutorCookie): string {
  const top = cookie.partitionKey?.topLevelSite;
  if (top) {
    try {
      const host = normalizeHost(new URL(top).hostname);
      if (host) return host;
    } catch {
      // fall through to the cookie domain
    }
  }
  return normalizeCookieDomain(cookie.domain);
}

export function cookieKey(cookie: ExecutorCookie): string {
  const pk = cookie.partitionKey;
  return [
    cookie.storeId,
    cookie.name,
    normalizeCookieDomain(cookie.domain),
    cookie.path,
    cookie.secure ? "s" : "",
    pk?.topLevelSite ?? "",
    pk?.hasCrossSiteAncestor === undefined ? "" : String(pk.hasCrossSiteAncestor),
  ].join("|");
}

/** URL that identifies a cookie for `cookies.remove` (scheme from `secure`, host from `domain`). */
export function cookieUrl(cookie: ExecutorCookie): string {
  const host = normalizeCookieDomain(cookie.domain);
  const path = cookie.path.startsWith("/") ? cookie.path : `/${cookie.path}`;
  return `${cookie.secure ? "https" : "http"}://${host}${path}`;
}

function dedupe(cookies: readonly ExecutorCookie[]): ExecutorCookie[] {
  const seen = new Map<string, ExecutorCookie>();
  for (const c of cookies) seen.set(cookieKey(c), c);
  return [...seen.values()];
}

/**
 * All cookies in a store, including partitioned ones where the browser supports the
 * `partitionKey` filter. Optionally restricted to a domain (and its subdomains).
 */
export async function listCookies(
  api: ExecutorApi,
  storeId: string,
  domain?: string,
): Promise<ExecutorCookie[]> {
  const base: CookiesGetAllDetails = { storeId, ...(domain ? { domain } : {}) };
  const plain = await api.cookies.getAll(base);
  let partitioned: ExecutorCookie[] = [];
  try {
    partitioned = await api.cookies.getAll({ ...base, partitionKey: {} });
  } catch {
    // Browser predates partitionKey support (Chrome < 119, Firefox < 100).
  }
  return dedupe([...plain, ...partitioned]);
}

/** Unique planning domains of a cookie list, sorted. */
export function planningDomains(cookies: readonly ExecutorCookie[]): string[] {
  return [...new Set(cookies.map(cookiePlanningDomain))].filter(Boolean).sort();
}

/** http + https origins for a domain, plus the `www.` variant for apex domains. */
export function originsForDomain(domain: string): string[] {
  const host = normalizeCookieDomain(domain);
  if (!host) return [];
  const hosts = new Set<string>([host]);
  if (!isIpHost(host) && host.includes(".") && siteOf(host) === host) {
    hosts.add(`www.${host}`);
  }
  const origins: string[] = [];
  for (const h of hosts) {
    origins.push(`https://${h}`, `http://${h}`);
  }
  return origins;
}

function hostsForDomains(domains: readonly string[]): string[] {
  const hosts = new Set<string>();
  for (const d of domains) {
    for (const origin of originsForDomain(d)) {
      hosts.add(origin.replace(/^https?:\/\//, ""));
    }
  }
  return [...hosts];
}

/**
 * Count cookies (all partitions) that belong to the site of `host`.
 */
export async function countCookiesForHost(
  api: ExecutorApi,
  storeId: string,
  host: string,
): Promise<number> {
  const h = normalizeHost(host);
  if (!h) return 0;
  const cookies = await listCookies(api, storeId, siteKey(h));
  return cookies.filter((c) => siteKey(cookiePlanningDomain(c)) === siteKey(h)).length;
}

async function removeSiteData(
  api: ExecutorApi,
  domains: readonly string[],
  extraHosts: readonly string[],
): Promise<Pick<ExecuteResult, "siteDataDomains" | "siteDataFailed" | "siteDataMode">> {
  const allHosts = [...domains, ...extraHosts.map((h) => normalizeHost(h)).filter(Boolean)];
  if (!api.browsingData || allHosts.length === 0) {
    return { siteDataDomains: 0, siteDataFailed: false, siteDataMode: "none" };
  }
  const origins = [...new Set(allHosts.flatMap(originsForDomain))];
  if (origins.length === 0) {
    return { siteDataDomains: 0, siteDataFailed: false, siteDataMode: "none" };
  }
  const count = new Set(allHosts.map(normalizeCookieDomain)).size;
  try {
    await api.browsingData.remove({ origins }, CHROME_SITE_DATA_TYPES);
    return { siteDataDomains: count, siteDataFailed: false, siteDataMode: "origins" };
  } catch {
    // Firefox: no `origins`, use `hostnames` with the types it understands.
  }
  try {
    await api.browsingData.remove(
      { hostnames: hostsForDomains(allHosts) },
      FIREFOX_SITE_DATA_TYPES,
    );
    return { siteDataDomains: count, siteDataFailed: false, siteDataMode: "hostnames" };
  } catch {
    return { siteDataDomains: 0, siteDataFailed: true, siteDataMode: "none" };
  }
}

/**
 * Remove every cookie in `storeId` whose planning domain is in `domains`, then (optionally)
 * the site data for those domains. `cookies` may be supplied to avoid a second `getAll`.
 */
export async function cleanDomainsInStore(
  api: ExecutorApi,
  storeId: string,
  domains: readonly string[],
  options: ExecuteOptions,
  cookies?: readonly ExecutorCookie[],
): Promise<ExecuteResult> {
  const targets = new Set(domains.map(normalizeCookieDomain).filter(Boolean));
  const result: ExecuteResult = {
    storeId,
    domains: [...targets].sort(),
    cookiesRemoved: 0,
    cookiesFailed: 0,
    siteDataDomains: 0,
    siteDataFailed: false,
    siteDataMode: "none",
  };
  const extraHosts = options.extraHosts ?? [];
  if (targets.size === 0 && !(options.cleanSiteData && extraHosts.length > 0)) return result;

  const all = targets.size === 0 ? [] : (cookies ?? (await listCookies(api, storeId)));
  const matching = all.filter((c) => c.storeId === storeId && targets.has(cookiePlanningDomain(c)));

  for (const cookie of matching) {
    const details: CookiesRemoveDetails = {
      url: cookieUrl(cookie),
      name: cookie.name,
      storeId,
      ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
    };
    try {
      await api.cookies.remove(details);
      result.cookiesRemoved += 1;
    } catch {
      result.cookiesFailed += 1;
    }
  }

  if (options.cleanSiteData) {
    Object.assign(result, await removeSiteData(api, result.domains, extraHosts));
  }
  return result;
}

export async function executeStorePlan(
  api: ExecutorApi,
  plan: StorePlan,
  options: ExecuteOptions,
  cookies?: readonly ExecutorCookie[],
): Promise<ExecuteResult> {
  return cleanDomainsInStore(api, plan.storeId, plan.cleanDomains, options, cookies);
}

export async function executePlan(
  api: ExecutorApi,
  plan: CleanupPlan,
  options: ExecuteOptions,
  cookiesByStore?: Readonly<Record<string, readonly ExecutorCookie[]>>,
): Promise<ExecuteResult[]> {
  const results: ExecuteResult[] = [];
  for (const store of plan.stores) {
    results.push(await executeStorePlan(api, store, options, cookiesByStore?.[store.storeId]));
  }
  return results;
}

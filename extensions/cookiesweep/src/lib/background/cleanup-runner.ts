import type { Clock, Logger } from "@browserforge/shared";
import {
  cleanDomainsInStore,
  executePlan,
  listCookies,
  planningDomains,
  type ExecuteResult,
  type ExecutorApi,
  type ExecutorCookie,
} from "../executor.js";
import type { CleanupSummary } from "../messages.js";
import { domainsForSite, planCleanup } from "../planner.js";
import type { ActivityEntry, CleanupTrigger, Settings } from "../settings.js";
import { summarizeResults, toActivityEntries } from "./activity.js";
import { openTabUrlsByStore, type OpenTab } from "./open-tabs.js";
import type { CookieStoreInfo, StoreRegistry } from "./store-registry.js";

export interface RunOptions {
  /** Run even when the extension is paused (explicit user action). */
  force?: boolean;
  /** Treat greylisted domains as expired. Defaults to `trigger === "startup"`. */
  greyExpired?: boolean;
}

export interface ActivityLog {
  append(entries: readonly ActivityEntry[]): Promise<void>;
}

/** Told what happened so the toolbar badge can react. */
export interface CleanupNotifier {
  sweepFinished(summary: CleanupSummary, settings: Settings): void;
  siteCleaned(): void;
}

export interface CleanupRunnerDeps {
  api: ExecutorApi;
  listTabs(): Promise<OpenTab[]>;
  registry: StoreRegistry;
  storeIdForTab(tabId: number | undefined): Promise<string>;
  loadSettings(): Promise<Settings>;
  activity: ActivityLog;
  notifier: CleanupNotifier;
  clock: Clock;
  logger: Logger;
}

export interface CleanupRunner {
  /** A scheduled or manual sweep. `null` when skipped because the extension is paused. */
  runCleanup(trigger: CleanupTrigger, options?: RunOptions): Promise<CleanupSummary | null>;
  /** Explicit "clean this site now": ignores lists and open tabs for that one site. */
  cleanSite(host: string, tabId?: number): Promise<CleanupSummary>;
}

interface StoreCookies {
  cookiesByStore: Record<string, ExecutorCookie[]>;
  cookieDomains: Record<string, string[]>;
}

export function createCleanupRunner(deps: CleanupRunnerDeps): CleanupRunner {
  /** Lists every store's cookies; a store the browser rejects is dropped from memory. */
  async function listStoreCookies(
    stores: readonly CookieStoreInfo[],
    remembered: ReadonlySet<string>,
  ): Promise<StoreCookies> {
    const out: StoreCookies = { cookiesByStore: {}, cookieDomains: {} };
    for (const store of stores) {
      try {
        const cookies = await listCookies(deps.api, store.id);
        out.cookiesByStore[store.id] = cookies;
        out.cookieDomains[store.id] = planningDomains(cookies);
      } catch (error) {
        deps.logger.warn("cookies.getAll failed for store", store.id, error);
        if (remembered.has(store.id)) await deps.registry.forget(store.id);
      }
    }
    return out;
  }

  async function record(trigger: CleanupTrigger, results: readonly ExecuteResult[]) {
    const entries = toActivityEntries(trigger, results, deps.clock());
    if (entries.length > 0) await deps.activity.append(entries);
  }

  async function runCleanup(
    trigger: CleanupTrigger,
    options: RunOptions = {},
  ): Promise<CleanupSummary | null> {
    const settings = await deps.loadSettings();
    if (!settings.enabled && !options.force) {
      deps.logger.debug("paused; skipping", trigger);
      return null;
    }

    const { stores, remembered } = await deps.registry.resolve();
    const openTabHosts = openTabUrlsByStore(await deps.listTabs(), stores);
    const { cookiesByStore, cookieDomains } = await listStoreCookies(stores, remembered);

    const plan = planCleanup({
      openTabHosts,
      cookieDomains,
      lists: settings.lists,
      greyExpiredAtRestart: options.greyExpired ?? trigger === "startup",
      trigger,
      startupScope: settings.cleanOnStartup ? "full" : "grey-only",
    });
    const results = await executePlan(
      deps.api,
      plan,
      { cleanSiteData: settings.cleanSiteData },
      cookiesByStore,
    );
    await record(trigger, results);

    const summary = summarizeResults(results);
    deps.logger.info(
      `${trigger}: removed ${summary.cookiesRemoved} cookie(s) from ${summary.domains.length} domain(s)`,
    );
    deps.notifier.sweepFinished(summary, settings);
    return summary;
  }

  async function cleanSite(host: string, tabId?: number): Promise<CleanupSummary> {
    const settings = await deps.loadSettings();
    const storeId = await deps.storeIdForTab(tabId);
    const cookies = await listCookies(deps.api, storeId);
    const domains = domainsForSite(planningDomains(cookies), host);
    const result = await cleanDomainsInStore(
      deps.api,
      { storeId, domains, cookies },
      { cleanSiteData: settings.cleanSiteData, extraHosts: [host] },
    );
    await record("manual", [result]);
    deps.logger.info(`manual: cleaned ${host} (${result.cookiesRemoved} cookie(s))`);
    deps.notifier.siteCleaned();
    return summarizeResults([result]);
  }

  return { runCleanup, cleanSite };
}

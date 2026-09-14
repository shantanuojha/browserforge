import { browser, type Browser } from "wxt/browser";
import type { BadgeTab } from "../lib/background/badge.js";
import type { OpenTab } from "../lib/background/open-tabs.js";
import type { CookieStoreInfo } from "../lib/background/store-registry.js";
import type {
  BrowsingDataRemovalOptions,
  BrowsingDataTypes,
  CookiesGetAllDetails,
  CookiesRemoveDetails,
  ExecutorApi,
  ExecutorCookie,
} from "../lib/executor.js";

/**
 * Thin adapters between the real `browser` object and the injectable shapes used by the
 * background services, plus small tab helpers shared with the popup and options page.
 */

export const DEFAULT_STORE_ID = "0";

function toExecutorCookie(cookie: Browser.cookies.Cookie): ExecutorCookie {
  const out: ExecutorCookie = {
    name: cookie.name,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    storeId: cookie.storeId,
  };
  if (cookie.partitionKey) {
    const pk: ExecutorCookie["partitionKey"] = {};
    if (cookie.partitionKey.topLevelSite !== undefined) {
      pk.topLevelSite = cookie.partitionKey.topLevelSite;
    }
    if (cookie.partitionKey.hasCrossSiteAncestor !== undefined) {
      pk.hasCrossSiteAncestor = cookie.partitionKey.hasCrossSiteAncestor;
    }
    out.partitionKey = pk;
  }
  return out;
}

export function createExecutorApi(): ExecutorApi {
  const api: ExecutorApi = {
    cookies: {
      async getAll(details: CookiesGetAllDetails) {
        const cookies = await browser.cookies.getAll(details as Browser.cookies.GetAllDetails);
        return cookies.map(toExecutorCookie);
      },
      async remove(details: CookiesRemoveDetails) {
        return browser.cookies.remove(details as Browser.cookies.CookieDetails);
      },
    },
  };
  if (browser.browsingData) {
    api.browsingData = {
      async remove(options: BrowsingDataRemovalOptions, dataTypes: BrowsingDataTypes) {
        await browser.browsingData.remove(
          options as Browser.browsingData.RemovalOptions,
          dataTypes as Browser.browsingData.DataTypeSet,
        );
      },
    };
  }
  return api;
}

export async function getCookieStores(): Promise<CookieStoreInfo[]> {
  try {
    const stores = await browser.cookies.getAllCookieStores();
    if (stores.length > 0) return stores.map((s) => ({ id: s.id, tabIds: [...s.tabIds] }));
  } catch {
    // Some browsers reject the call without the cookies permission; fall back to the default store.
  }
  return [{ id: DEFAULT_STORE_ID, tabIds: [] }];
}

/** Cookie store that owns a tab, defaulting to the first store when unknown. */
export async function storeIdForTab(tabId: number | undefined): Promise<string> {
  const stores = await getCookieStores();
  if (tabId !== undefined) {
    const owner = stores.find((s) => s.tabIds.includes(tabId));
    if (owner) return owner.id;
  }
  return stores[0]?.id ?? DEFAULT_STORE_ID;
}

export async function getActiveTab(): Promise<Browser.tabs.Tab | undefined> {
  const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs[0]) return tabs[0];
  const fallback = await browser.tabs.query({ active: true, currentWindow: true });
  return fallback[0];
}

export function tabUrl(tab: Browser.tabs.Tab | undefined): string | undefined {
  return tab?.url || tab?.pendingUrl || undefined;
}

export function listOpenTabs(): Promise<OpenTab[]> {
  return browser.tabs.query({});
}

/** The given tab, or the active one; undefined when it has been closed in the meantime. */
export async function resolveBadgeTab(tabId?: number): Promise<BadgeTab | undefined> {
  try {
    const tab = tabId !== undefined ? await browser.tabs.get(tabId) : await getActiveTab();
    return tab && tab.id !== undefined ? { ...tab, id: tab.id } : undefined;
  } catch {
    return undefined;
  }
}

/** `browser.action` on MV3, `browser.browserAction` on Firefox MV2. */
export function getActionApi(): typeof browser.action | undefined {
  if (browser.action) return browser.action;
  const legacy = (browser as unknown as { browserAction?: typeof browser.action }).browserAction;
  return legacy;
}

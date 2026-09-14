import type { CookieStoreInfo } from "./store-registry.js";

/** The parts of `tabs.Tab` the planner cares about. */
export interface OpenTab {
  id?: number | undefined;
  url?: string | undefined;
  pendingUrl?: string | undefined;
}

/**
 * A tab mid-navigation owns two sites: the committed one (`url`) and the one it is loading
 * (`pendingUrl`). Both must be protected or the user arrives at the destination logged out.
 */
export function urlsOfTab(tab: OpenTab): string[] {
  return [tab.url, tab.pendingUrl].filter((u): u is string => !!u);
}

/**
 * Tab URLs per cookie store. Tabs the browser did not attribute to any store are protected in
 * every store, because guessing wrong would log the user out.
 */
export function openTabUrlsByStore(
  tabs: readonly OpenTab[],
  stores: readonly CookieStoreInfo[],
): Record<string, string[]> {
  const urlsByTab = new Map<number, string[]>();
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    const urls = urlsOfTab(tab);
    if (urls.length > 0) urlsByTab.set(tab.id, urls);
  }

  const assigned = new Set<number>();
  const byStore: Record<string, string[]> = {};
  for (const store of stores) {
    byStore[store.id] = store.tabIds.flatMap((id) => {
      assigned.add(id);
      return urlsByTab.get(id) ?? [];
    });
  }
  const orphanUrls = [...urlsByTab.entries()]
    .filter(([id]) => !assigned.has(id))
    .flatMap(([, urls]) => urls);
  if (orphanUrls.length > 0) {
    for (const store of stores) byStore[store.id]?.push(...orphanUrls);
  }
  return byStore;
}

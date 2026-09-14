export interface CookieStoreInfo {
  id: string;
  tabIds: number[];
}

/** Persistent list of store ids we have seen; `StorageKey<string[]>` satisfies it. */
export interface KnownStoresStore {
  get(): Promise<string[]>;
  set(ids: string[]): Promise<void>;
  update(fn: (current: string[]) => string[]): Promise<string[]>;
}

export interface StoreRegistryDeps {
  /** `cookies.getAllCookieStores()`, already normalised. */
  listLiveStores(): Promise<CookieStoreInfo[]>;
  known: KnownStoresStore;
}

export interface ResolvedStores {
  /** Live stores plus remembered ones (which carry no tabs), sorted by id. */
  stores: CookieStoreInfo[];
  /** Ids that are only remembered, not currently listed by the browser. */
  remembered: Set<string>;
}

export interface StoreRegistry {
  resolve(): Promise<ResolvedStores>;
  /** The browser rejected a remembered store: stop trying it. */
  forget(storeId: string): Promise<void>;
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Live stores plus the ones we have seen before. `cookies.getAllCookieStores()` only lists
 * stores that currently own a tab (Firefox always, Chrome for incognito), so a container drops
 * out of the list the moment its last tab closes: exactly when its cookies need cleaning.
 * Remembered stores carry no tabs; the browser is asked to forget them once it rejects them.
 */
export function createStoreRegistry(deps: StoreRegistryDeps): StoreRegistry {
  return {
    async resolve() {
      const live = await deps.listLiveStores();
      const liveIds = new Set(live.map((s) => s.id));
      const known = await deps.known.get();
      const remembered = new Set(known.filter((id) => !liveIds.has(id)));
      const all = [...new Set([...known, ...liveIds])].sort();
      if (!sameList(all, known)) await deps.known.set(all);
      const stores = all.map((id) => live.find((s) => s.id === id) ?? { id, tabIds: [] });
      return { stores, remembered };
    },
    async forget(storeId) {
      await deps.known.update((ids) => ids.filter((id) => id !== storeId));
    },
  };
}

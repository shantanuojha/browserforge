/// <reference types="chrome" />

/**
 * Typed helpers over `chrome.storage.local` / `chrome.storage.sync`.
 *
 * These are intentionally schema-free: the generic parameter is trusted at the
 * call site. Callers that need validation should wrap `get` with their own parser.
 */

export type StorageAreaName = "local" | "sync";

export interface StorageArea {
  readonly name: StorageAreaName;
  get<T>(key: string): Promise<T | undefined>;
  get<T>(key: string, fallback: T): Promise<T>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string | readonly string[]): Promise<void>;
  clear(): Promise<void>;
  /** Subscribe to changes of a single key. Returns an unsubscribe function. */
  watch<T>(key: string, callback: (next: T | undefined, prev: T | undefined) => void): () => void;
}

function area(name: StorageAreaName): chrome.storage.StorageArea {
  return chrome.storage[name];
}

function createStorageArea(name: StorageAreaName): StorageArea {
  return {
    name,

    async get<T>(key: string, fallback?: T): Promise<T | undefined> {
      const result = await area(name).get(key);
      const value = result[key] as T | undefined;
      return value === undefined ? fallback : value;
    },

    async set<T>(key: string, value: T): Promise<void> {
      await area(name).set({ [key]: value });
    },

    async remove(key: string | readonly string[]): Promise<void> {
      await area(name).remove(typeof key === "string" ? key : [...key]);
    },

    async clear(): Promise<void> {
      await area(name).clear();
    },

    watch<T>(key: string, callback: (next: T | undefined, prev: T | undefined) => void) {
      const listener = (
        changes: { [k: string]: chrome.storage.StorageChange },
        areaName: string,
      ) => {
        if (areaName !== name) return;
        const change = changes[key];
        if (!change) return;
        callback(change.newValue as T | undefined, change.oldValue as T | undefined);
      };
      chrome.storage.onChanged.addListener(listener);
      return () => chrome.storage.onChanged.removeListener(listener);
    },
  } as StorageArea;
}

export const localStorage: StorageArea = createStorageArea("local");
export const syncStorage: StorageArea = createStorageArea("sync");

/** A key bound to an area and a default value, for ergonomic typed access. */
export interface StorageKey<T> {
  readonly key: string;
  readonly area: StorageArea;
  readonly fallback: T;
  get(): Promise<T>;
  set(value: T): Promise<void>;
  update(fn: (current: T) => T): Promise<T>;
  watch(callback: (next: T, prev: T) => void): () => void;
}

export function defineStorageKey<T>(
  key: string,
  fallback: T,
  areaName: StorageAreaName = "local",
): StorageKey<T> {
  const storageArea = areaName === "sync" ? syncStorage : localStorage;
  const item: StorageKey<T> = {
    key,
    area: storageArea,
    fallback,
    get: () => storageArea.get<T>(key, fallback),
    set: (value) => storageArea.set<T>(key, value),
    async update(fn) {
      const next = fn(await item.get());
      await item.set(next);
      return next;
    },
    watch: (callback) =>
      storageArea.watch<T>(key, (next, prev) => callback(next ?? fallback, prev ?? fallback)),
  };
  return item;
}

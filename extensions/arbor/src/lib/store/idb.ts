/**
 * Tiny promise wrappers over raw IndexedDB. Only the subset Arbor needs; no library.
 */

export const DB_NAME = "arbor";
export const DB_VERSION = 1;

export const STORES = {
  ops: "ops",
  snapshots: "snapshots",
  snapshotMeta: "snapshotMeta",
  quarantine: "quarantine",
  backups: "backups",
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function awaitTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export function openDatabase(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: name === STORES.backups ? "ts" : "seq" });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("could not open IndexedDB"));
    req.onblocked = () => reject(new Error("IndexedDB open blocked by another connection"));
  });
}

/**
 * Run `fn` inside a transaction over `names` and resolve when the transaction completes.
 * `fn` receives a lookup for the stores and returns the value to resolve with.
 */
export async function withStores<T>(
  db: IDBDatabase,
  names: readonly StoreName[],
  mode: IDBTransactionMode,
  fn: (store: (name: StoreName) => IDBObjectStore) => Promise<T>,
): Promise<T> {
  const tx = db.transaction([...names], mode);
  const done = awaitTransaction(tx);
  const result = await fn((name) => tx.objectStore(name));
  await done;
  return result;
}

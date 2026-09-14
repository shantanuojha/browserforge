import { browser } from "wxt/browser";
import type { SyncArea } from "../lib/sync/store";
import { SYNC_META_KEY } from "../lib/sync/codec";

/** `browser.storage.sync` behind the sync store's port. */
export const browserSyncArea: SyncArea = {
  getAll: () => browser.storage.sync.get(null),
  set: (items) => browser.storage.sync.set(items),
  remove: (keys) => browser.storage.sync.remove(keys),
};

/** Calls `callback` whenever another context (or device) rewrites the sync manifest. */
export function onSyncManifestChanged(callback: () => void): () => void {
  const listener = (changes: Record<string, unknown>, area: string) => {
    if (area === "sync" && SYNC_META_KEY in changes) callback();
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

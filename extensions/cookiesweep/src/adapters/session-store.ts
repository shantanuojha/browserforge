import { browser, type Browser } from "wxt/browser";
import type { SessionStore } from "../lib/background/scheduler.js";

function sessionArea(): Browser.storage.StorageArea | undefined {
  return (browser.storage as { session?: Browser.storage.StorageArea }).session;
}

/**
 * `storage.session` when the browser has it (survives service-worker restarts), with an
 * in-memory fallback for browsers that do not.
 */
export function createBrowserSessionStore(): SessionStore {
  const memory = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const area = sessionArea();
      if (area) {
        try {
          return (await area.get(key))[key] as T | undefined;
        } catch {
          // storage.session unavailable in this context; fall back to memory.
        }
      }
      return memory.get(key) as T | undefined;
    },
    async set(key, value) {
      const area = sessionArea();
      if (area) {
        try {
          if (value === undefined) await area.remove(key);
          else await area.set({ [key]: value });
          return;
        } catch {
          // storage.session unavailable in this context; fall back to memory.
        }
      }
      if (value === undefined) memory.delete(key);
      else memory.set(key, value);
    },
  };
}

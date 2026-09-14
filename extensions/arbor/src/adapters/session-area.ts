/**
 * `storage.session` for state that should outlive a page but not the browser session (the
 * panel's undo stack). It exists in Chromium 102+ and Firefox 115+; elsewhere there is no
 * persistence and the caller keeps its state in memory.
 */
import { browser } from "wxt/browser";

export interface SessionArea {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

interface RawSessionArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export function sessionArea(): SessionArea | undefined {
  const area = (browser.storage as { session?: Partial<RawSessionArea> }).session;
  if (!area || typeof area.get !== "function" || typeof area.set !== "function") return undefined;
  const raw = area as RawSessionArea;
  return {
    get: async (key) => (await raw.get(key))[key],
    set: (key, value) => raw.set({ [key]: value }),
  };
}

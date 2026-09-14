/** Loads the bundled static ruleset (data file, never remote) for the JS-side cleaner. */

import { browser, type PublicPath } from "wxt/browser";
import type { DnrRule } from "../lib/dnr";

export interface TrackingMeta {
  generatedAt: string;
  source: string;
  usedFallback: boolean;
  providersTotal: number;
  providersUsed: number;
  rulesGenerated: number;
  removeParamRules: number;
  exceptionRules: number;
  regexRules: number;
  providers: string[];
}

/** Fetches a bundled JSON asset once; a failed load is forgotten so the next call retries. */
function bundledJson<T>(path: PublicPath, fallback: T): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= fetch(browser.runtime.getURL(path))
      .then(async (res) => (res.ok ? ((await res.json()) as T) : fallback))
      .catch(() => {
        pending = null;
        return fallback;
      });
    return pending;
  };
}

export const loadTrackingRules = bundledJson<DnrRule[]>("/rules/tracking-params.json", []);
export const loadTrackingMeta = bundledJson<TrackingMeta | null>(
  "/rules/tracking-params.meta.json",
  null,
);

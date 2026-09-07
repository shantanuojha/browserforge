/** Loads the bundled static ruleset (data file, never remote) for the JS-side cleaner. */

import { browser } from "wxt/browser";
import type { DnrRule } from "../dnr";

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

let rulesPromise: Promise<DnrRule[]> | null = null;
let metaPromise: Promise<TrackingMeta | null> | null = null;

export function loadTrackingRules(): Promise<DnrRule[]> {
  rulesPromise ??= fetch(browser.runtime.getURL("/rules/tracking-params.json"))
    .then((r) => (r.ok ? (r.json() as Promise<DnrRule[]>) : []))
    .catch(() => {
      rulesPromise = null;
      return [] as DnrRule[];
    });
  return rulesPromise;
}

export function loadTrackingMeta(): Promise<TrackingMeta | null> {
  metaPromise ??= fetch(browser.runtime.getURL("/rules/tracking-params.meta.json"))
    .then((r) => (r.ok ? (r.json() as Promise<TrackingMeta>) : null))
    .catch(() => {
      metaPromise = null;
      return null;
    });
  return metaPromise;
}

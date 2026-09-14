import type { ExecuteResult } from "../executor.js";
import type { CleanupSummary } from "../messages.js";
import { createActivityId, type ActivityEntry, type CleanupTrigger } from "../settings.js";

export const EMPTY_SUMMARY: CleanupSummary = { cookiesRemoved: 0, siteDataDomains: 0, domains: [] };

const removedSomething = (result: ExecuteResult): boolean =>
  result.cookiesRemoved > 0 || result.siteDataDomains > 0;

/** Totals across stores; only domains where something was actually removed are listed. */
export function summarizeResults(results: readonly ExecuteResult[]): CleanupSummary {
  const domains = new Set<string>();
  let cookiesRemoved = 0;
  let siteDataDomains = 0;
  for (const result of results) {
    cookiesRemoved += result.cookiesRemoved;
    siteDataDomains += result.siteDataDomains;
    if (removedSomething(result)) result.domains.forEach((d) => domains.add(d));
  }
  return { cookiesRemoved, siteDataDomains, domains: [...domains].sort() };
}

/** One activity entry per store that removed something. */
export function toActivityEntries(
  trigger: CleanupTrigger,
  results: readonly ExecuteResult[],
  now: number,
  createId: (now: number) => string = createActivityId,
): ActivityEntry[] {
  return results.filter(removedSomething).map((result) => ({
    id: createId(now),
    at: now,
    trigger,
    storeId: result.storeId,
    domains: result.domains,
    cookiesRemoved: result.cookiesRemoved,
    siteDataDomains: result.siteDataDomains,
  }));
}

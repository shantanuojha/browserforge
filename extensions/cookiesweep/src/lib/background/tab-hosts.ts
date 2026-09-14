import { hostFromTabUrl, sameSite } from "../planner.js";
import { urlsOfTab, type OpenTab } from "./open-tabs.js";

/**
 * Last known http(s) host per tab, so a committed navigation can be classified as "left the
 * site" (schedule a cleanup) or "same site" (nothing to do).
 */
export class TabHostTracker {
  private readonly hosts = new Map<number, string | null>();

  /** Learns tabs that opened while the worker was dead; known tabs are left as they are. */
  prime(tabs: readonly OpenTab[]): void {
    for (const tab of tabs) {
      if (tab.id !== undefined && !this.hosts.has(tab.id)) {
        this.hosts.set(tab.id, hostFromTabUrl(urlsOfTab(tab)[0]));
      }
    }
  }

  forget(tabId: number): void {
    this.hosts.delete(tabId);
  }

  /**
   * Records the host a tab just committed. Returns true when a cleanup should be considered:
   * the tab is new to us, or it left the site it was on (including to a non-web page).
   */
  commit(tabId: number, nextHost: string | null): boolean {
    const known = this.hosts.has(tabId);
    const previous = this.hosts.get(tabId) ?? null;
    this.hosts.set(tabId, nextHost);
    const leftSite = previous !== null && (nextHost === null || !sameSite(previous, nextHost));
    return !known || leftSite;
  }
}

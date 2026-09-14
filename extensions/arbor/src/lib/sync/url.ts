/** URL and title rules shared by the tracker's collaborators. */
import type { LiveTab } from "./types";

export function tabTitle(tab: { title?: string | undefined; url?: string | undefined }): string {
  if (tab.title) return tab.title;
  if (tab.url) {
    try {
      return new URL(tab.url).hostname || tab.url;
    } catch {
      return tab.url;
    }
  }
  return "New tab";
}

/** Same page for matching purposes: trailing slash and http/https do not count. */
export function sameUrl(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const strip = (u: string) => u.replace(/\/$/, "").replace(/^http:\/\//, "https://");
  return strip(a) === strip(b);
}

/**
 * What the tab shows, or is about to: a tab still committing its first navigation reports
 * url "" and the page in `pendingUrl`.
 */
export function currentUrl(tab: LiveTab): string | undefined {
  return tab.url || tab.pendingUrl;
}

/** Where the tab is heading, preferring the navigation in flight over the page it left. */
export function targetUrl(tab: LiveTab): string | undefined {
  return tab.pendingUrl || tab.url;
}

/** Browser-agnostic views of tabs/windows so the tracker can be unit-tested without `browser.*`. */

export interface LiveTab {
  id: number;
  windowId: number;
  index: number;
  title?: string | undefined;
  url?: string | undefined;
  /** URL while a navigation is in flight (Chrome sets this before `url`). */
  pendingUrl?: string | undefined;
  favIconUrl?: string | undefined;
  active?: boolean | undefined;
  openerTabId?: number | undefined;
}

export interface LiveWindow {
  id: number;
  type?: string | undefined;
  focused?: boolean | undefined;
  incognito?: boolean | undefined;
}

export interface TabsPort {
  queryAll(): Promise<{ tabs: LiveTab[]; windows: LiveWindow[] }>;
  createTab(opts: {
    url: string;
    windowId?: number | undefined;
    index?: number | undefined;
    active?: boolean | undefined;
  }): Promise<LiveTab>;
  createWindow(urls: string[]): Promise<{ window: LiveWindow; tabs: LiveTab[] }>;
  removeTabs(ids: number[]): Promise<void>;
  focusTab(tabId: number, windowId: number): Promise<void>;
  moveTab(tabId: number, windowId: number, index: number): Promise<void>;
  /** Id of the last focused normal window, if any. */
  currentWindowId(): Promise<number | undefined>;
}

export interface RebuildReport {
  windowsMatched: number;
  windowsCreated: number;
  tabsMatched: number;
  tabsCreated: number;
  nodesSaved: number;
  nodesDropped: number;
}

/** URLs that carry no information worth keeping when the tab closes. */
export function isBlankUrl(url: string | undefined): boolean {
  if (!url) return true;
  return (
    url === "about:blank" ||
    url === "about:newtab" ||
    url === "about:home" ||
    url.startsWith("chrome://newtab") ||
    url.startsWith("chrome://new-tab-page") ||
    url.startsWith("edge://newtab") ||
    url.startsWith("chrome-search://")
  );
}

export function isTrackableWindow(w: LiveWindow): boolean {
  return w.type === undefined || w.type === "normal";
}

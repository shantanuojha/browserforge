/**
 * `TabsPort` over the real `browser.tabs` / `browser.windows` APIs, plus the converters from the
 * browser's tab and window records to the tracker's browser-agnostic views. Thin: type
 * conversion and browser-specific failure handling only; every decision lives in `lib/sync`.
 */
import { browser, type Browser } from "wxt/browser";
import type { LiveTab, LiveWindow, TabsPort } from "../lib/sync/types";

export function toLiveTab(tab: Browser.tabs.Tab): LiveTab | undefined {
  if (tab.id === undefined || tab.windowId === undefined) return undefined;
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    title: tab.title,
    url: tab.url,
    pendingUrl: tab.pendingUrl,
    favIconUrl: tab.favIconUrl,
    active: tab.active,
    openerTabId: tab.openerTabId,
  };
}

export function toLiveWindow(win: Browser.windows.Window): LiveWindow | undefined {
  if (win.id === undefined) return undefined;
  return { id: win.id, type: win.type, focused: win.focused, incognito: win.incognito };
}

function defined<T>(v: T | undefined): v is T {
  return v !== undefined;
}

export const browserTabsPort: TabsPort = {
  async queryAll() {
    // All window types: the tracker records which ones to ignore (popups, devtools, apps).
    const [tabs, windows] = await Promise.all([browser.tabs.query({}), browser.windows.getAll({})]);
    return {
      tabs: tabs.map(toLiveTab).filter(defined),
      windows: windows.map(toLiveWindow).filter(defined),
    };
  },
  async createTab(opts) {
    const tab = await browser.tabs.create({
      url: opts.url,
      windowId: opts.windowId,
      index: opts.index,
      active: opts.active ?? true,
    });
    const live = toLiveTab(tab);
    if (!live) throw new Error("tabs.create returned a tab without an id");
    return live;
  },
  async createWindow(urls, moveTabId) {
    const win = urls.length
      ? await browser.windows.create({ url: urls, focused: true })
      : await browser.windows.create({ tabId: moveTabId, focused: true });
    const live = win ? toLiveWindow(win) : undefined;
    if (!live) throw new Error("windows.create returned no window");
    const tabs = (win?.tabs ?? []).map(toLiveTab).filter(defined);
    return { window: live, tabs };
  },
  async removeTabs(ids) {
    if (!ids.length) return;
    try {
      await browser.tabs.remove(ids);
    } catch {
      // Some ids may already be gone; close the rest one by one.
      await Promise.allSettled(ids.map((id) => browser.tabs.remove(id)));
    }
  },
  async focusTab(tabId, windowId) {
    await browser.tabs.update(tabId, { active: true });
    await browser.windows.update(windowId, { focused: true });
  },
  async moveTab(tabId, windowId, index) {
    await browser.tabs.move(tabId, { windowId, index });
  },
  async currentWindowId() {
    try {
      const win = await browser.windows.getLastFocused({ windowTypes: ["normal"] });
      return win.id;
    } catch {
      return undefined;
    }
  },
};

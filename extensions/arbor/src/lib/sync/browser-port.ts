import { browser, type Browser } from "wxt/browser";
import type { TabTracker } from "./tracker";
import type { LiveTab, LiveWindow, TabsPort } from "./types";

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

/** `TabsPort` backed by the real extension APIs. */
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
  async createWindow(urls) {
    const win = await browser.windows.create({ url: urls, focused: true });
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

/**
 * Wire browser events into the tracker. Listeners are registered synchronously (MV3 needs that
 * to wake the worker) and each event waits for `ready` before touching the tracker, so events
 * that arrive during startup are processed in order once the tree is loaded.
 */
export function bindTrackerEvents(tracker: TabTracker, ready: Promise<unknown>): () => void {
  const gated =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A) => {
      void ready.then(
        () => fn(...args),
        () => undefined,
      );
    };

  const onTabCreated = gated((tab: Browser.tabs.Tab) => {
    const live = toLiveTab(tab);
    if (live) tracker.handleTabCreated(live);
  });
  const onTabUpdated = gated((tabId: number, _change: unknown, tab: Browser.tabs.Tab) => {
    const live = toLiveTab(tab);
    if (live) tracker.handleTabUpdated(tabId, live);
  });
  const onTabMoved = gated((tabId: number, info: { windowId: number; toIndex: number }) =>
    tracker.handleTabMoved(tabId, info),
  );
  const onTabAttached = gated((tabId: number, info: { newWindowId: number; newPosition: number }) =>
    tracker.handleTabAttached(tabId, info),
  );
  const onTabDetached = gated((tabId: number, info: { oldWindowId: number }) =>
    tracker.handleTabDetached(tabId, info),
  );
  const onTabRemoved = gated((tabId: number) => tracker.handleTabRemoved(tabId));
  const onTabReplaced = gated((added: number, removed: number) =>
    tracker.handleTabReplaced(added, removed),
  );
  const onTabActivated = gated((info: { tabId: number; windowId: number }) =>
    tracker.handleTabActivated(info),
  );
  const onWindowCreated = gated((win: Browser.windows.Window) => {
    const live = toLiveWindow(win);
    if (live) tracker.handleWindowCreated(live);
  });
  const onWindowRemoved = gated((windowId: number) => tracker.handleWindowRemoved(windowId));
  const onWindowFocus = gated((windowId: number) =>
    tracker.handleWindowFocusChanged(
      windowId === browser.windows.WINDOW_ID_NONE ? undefined : windowId,
    ),
  );

  browser.tabs.onCreated.addListener(onTabCreated);
  browser.tabs.onUpdated.addListener(onTabUpdated);
  browser.tabs.onMoved.addListener(onTabMoved);
  browser.tabs.onAttached.addListener(onTabAttached);
  browser.tabs.onDetached.addListener(onTabDetached);
  browser.tabs.onRemoved.addListener(onTabRemoved);
  browser.tabs.onReplaced.addListener(onTabReplaced);
  browser.tabs.onActivated.addListener(onTabActivated);
  browser.windows.onCreated.addListener(onWindowCreated);
  browser.windows.onRemoved.addListener(onWindowRemoved);
  browser.windows.onFocusChanged.addListener(onWindowFocus);

  return () => {
    browser.tabs.onCreated.removeListener(onTabCreated);
    browser.tabs.onUpdated.removeListener(onTabUpdated);
    browser.tabs.onMoved.removeListener(onTabMoved);
    browser.tabs.onAttached.removeListener(onTabAttached);
    browser.tabs.onDetached.removeListener(onTabDetached);
    browser.tabs.onRemoved.removeListener(onTabRemoved);
    browser.tabs.onReplaced.removeListener(onTabReplaced);
    browser.tabs.onActivated.removeListener(onTabActivated);
    browser.windows.onCreated.removeListener(onWindowCreated);
    browser.windows.onRemoved.removeListener(onWindowRemoved);
    browser.windows.onFocusChanged.removeListener(onWindowFocus);
  };
}

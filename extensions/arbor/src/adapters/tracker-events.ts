/**
 * Wires `browser.tabs` / `browser.windows` events into a `TrackerEventSink`. Listeners are
 * registered synchronously (MV3 needs that to wake the worker) and each event waits for `ready`
 * before touching the sink, so events that arrive during startup are processed in order once the
 * tree is loaded.
 */
import { browser, type Browser } from "wxt/browser";
import type { TrackerEventSink } from "../lib/sync/types";
import { toLiveTab, toLiveWindow } from "./tabs-port";

type Gate = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => void;

function gateOn(ready: Promise<unknown>): Gate {
  return (fn) =>
    (...args) => {
      void ready.then(
        () => fn(...args),
        () => undefined,
      );
    };
}

interface Subscription {
  unsubscribe(): void;
}

function listen<L extends (...args: never[]) => void>(
  event: { addListener(listener: L): void; removeListener(listener: L): void },
  listener: L,
): Subscription {
  event.addListener(listener);
  return { unsubscribe: () => event.removeListener(listener) };
}

function tabSubscriptions(sink: TrackerEventSink, gated: Gate): Subscription[] {
  const tabs = browser.tabs;
  return [
    listen(
      tabs.onCreated,
      gated((tab: Browser.tabs.Tab) => {
        const live = toLiveTab(tab);
        if (live) sink.handleTabCreated(live);
      }),
    ),
    listen(
      tabs.onUpdated,
      gated((tabId: number, _change: unknown, tab: Browser.tabs.Tab) => {
        const live = toLiveTab(tab);
        if (live) sink.handleTabUpdated(tabId, live);
      }),
    ),
    listen(
      tabs.onMoved,
      gated((tabId: number, info: { windowId: number; toIndex: number }) =>
        sink.handleTabMoved(tabId, info),
      ),
    ),
    listen(
      tabs.onAttached,
      gated((tabId: number, info: { newWindowId: number; newPosition: number }) =>
        sink.handleTabAttached(tabId, info),
      ),
    ),
    listen(
      tabs.onDetached,
      gated((tabId: number, info: { oldWindowId: number }) => sink.handleTabDetached(tabId, info)),
    ),
    listen(
      tabs.onRemoved,
      gated((tabId: number) => sink.handleTabRemoved(tabId)),
    ),
    listen(
      tabs.onReplaced,
      gated((added: number, removed: number) => sink.handleTabReplaced(added, removed)),
    ),
    listen(
      tabs.onActivated,
      gated((info: { tabId: number; windowId: number }) => sink.handleTabActivated(info)),
    ),
  ];
}

function windowSubscriptions(sink: TrackerEventSink, gated: Gate): Subscription[] {
  const windows = browser.windows;
  return [
    listen(
      windows.onCreated,
      gated((win: Browser.windows.Window) => {
        const live = toLiveWindow(win);
        if (live) sink.handleWindowCreated(live);
      }),
    ),
    listen(
      windows.onRemoved,
      gated((windowId: number) => sink.handleWindowRemoved(windowId)),
    ),
    listen(
      windows.onFocusChanged,
      gated((windowId: number) =>
        sink.handleWindowFocusChanged(
          windowId === browser.windows.WINDOW_ID_NONE ? undefined : windowId,
        ),
      ),
    ),
  ];
}

/**
 * The two events that change what the panel highlights without changing the tree: the active
 * tab of a window and the focused window.
 */
export function onLiveFocusChanged(listener: () => void): void {
  browser.tabs.onActivated.addListener(() => listener());
  browser.windows.onFocusChanged.addListener(() => listener());
}

/** Returns the function that removes every listener again. */
export function bindTrackerEvents(sink: TrackerEventSink, ready: Promise<unknown>): () => void {
  const gated = gateOn(ready);
  const subscriptions = [...tabSubscriptions(sink, gated), ...windowSubscriptions(sink, gated)];
  return () => {
    for (const subscription of subscriptions) subscription.unsubscribe();
  };
}

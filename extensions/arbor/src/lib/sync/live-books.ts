/**
 * The tracker's copy of the browser's own state: which windows exist and are worth tracking,
 * the tab strip of each window (ids in order), the last known record of every tab, the active
 * tab per window and the focused window. Nothing here touches the tree.
 */
import type { LiveTab } from "./types";

export interface LiveState {
  activeTabIds: number[];
  focusedWindowId: number | undefined;
}

export class LiveBooks {
  /** Browser tab order per window (ids in strip order). */
  private readonly windowTabs = new Map<number, number[]>();
  private readonly tabs = new Map<number, LiveTab>();
  private readonly activeTabs = new Map<number, number>();
  /** Window ids we have seen, with whether they are worth tracking (normal windows only). */
  private readonly knownWindows = new Map<number, boolean>();
  focusedWindowId: number | undefined;

  reset(): void {
    this.windowTabs.clear();
    this.tabs.clear();
    this.activeTabs.clear();
    this.knownWindows.clear();
    this.focusedWindowId = undefined;
  }

  getLiveState(): LiveState {
    return { activeTabIds: [...this.activeTabs.values()], focusedWindowId: this.focusedWindowId };
  }

  // -- strips ---------------------------------------------------------------------------------

  /** The strip of `windowId`, created empty on first use. */
  orderOf(windowId: number): number[] {
    let order = this.windowTabs.get(windowId);
    if (!order) {
      order = [];
      this.windowTabs.set(windowId, order);
    }
    return order;
  }

  /** The strip of `windowId` if we hold one. */
  stripOf(windowId: number): readonly number[] | undefined {
    return this.windowTabs.get(windowId);
  }

  /** Take `tabId` out of the strip of `windowId` (its record stays: attach follows detach). */
  removeFromStrip(tabId: number, windowId: number): void {
    const order = this.windowTabs.get(windowId);
    if (!order) return;
    const i = order.indexOf(tabId);
    if (i >= 0) order.splice(i, 1);
  }

  /** Reflect `tabs.onMoved`: the tab now sits at `toIndex` of `windowId`. False for unknown tabs. */
  moveInStrip(tabId: number, windowId: number, toIndex: number): boolean {
    const record = this.tabs.get(tabId);
    if (!record) return false;
    const order = this.orderOf(windowId);
    const from = order.indexOf(tabId);
    if (from >= 0) order.splice(from, 1);
    order.splice(Math.max(0, Math.min(toIndex, order.length)), 0, tabId);
    this.tabs.set(tabId, { ...record, windowId });
    return true;
  }

  // -- tab records ----------------------------------------------------------------------------

  tab(tabId: number): LiveTab | undefined {
    return this.tabs.get(tabId);
  }

  hasTab(tabId: number): boolean {
    return this.tabs.has(tabId);
  }

  tabRecords(): IterableIterator<LiveTab> {
    return this.tabs.values();
  }

  /** Overwrite the record of a tab we already track (its strip position is kept). */
  updateTab(tabId: number, tab: LiveTab): void {
    const record = this.tabs.get(tabId);
    if (record) this.tabs.set(tabId, { ...record, ...tab, index: record.index });
  }

  insertTabRecord(tab: LiveTab): void {
    this.removeTabRecord(tab.id);
    const order = this.orderOf(tab.windowId);
    order.splice(Math.max(0, Math.min(tab.index, order.length)), 0, tab.id);
    this.tabs.set(tab.id, { ...tab });
    if (tab.active) this.activeTabs.set(tab.windowId, tab.id);
  }

  removeTabRecord(tabId: number): void {
    const prev = this.tabs.get(tabId);
    if (!prev) return;
    this.removeFromStrip(tabId, prev.windowId);
    this.tabs.delete(tabId);
    if (this.activeTabs.get(prev.windowId) === tabId) this.activeTabs.delete(prev.windowId);
  }

  /**
   * `tabs.onReplaced` (prerender): the tab keeps its place under a new id. Returns false when
   * the old id was unknown, so the caller can decide how to catch up.
   */
  replaceTabId(removedTabId: number, addedTabId: number): boolean {
    const record = this.tabs.get(removedTabId);
    if (!record) return false;
    const order = this.orderOf(record.windowId);
    const i = order.indexOf(removedTabId);
    if (i >= 0) order[i] = addedTabId;
    this.tabs.delete(removedTabId);
    this.tabs.set(addedTabId, { ...record, id: addedTabId });
    if (this.activeTabs.get(record.windowId) === removedTabId) {
      this.activeTabs.set(record.windowId, addedTabId);
    }
    return true;
  }

  // -- activation and focus -------------------------------------------------------------------

  setActive(windowId: number, tabId: number): void {
    this.activeTabs.set(windowId, tabId);
    const record = this.tabs.get(tabId);
    if (record) this.tabs.set(tabId, { ...record, active: true });
  }

  /** The active tab of a window, else its first tab, else nothing. */
  activeOrFirstTab(windowId: number): number | undefined {
    return this.activeTabs.get(windowId) ?? this.orderOf(windowId)[0];
  }

  // -- windows --------------------------------------------------------------------------------

  noteWindow(windowId: number, trackable: boolean): void {
    this.knownWindows.set(windowId, trackable);
  }

  /** The browser window is gone: drop every record that pointed at it. */
  forgetWindow(windowId: number): void {
    this.knownWindows.delete(windowId);
    for (const tabId of [...(this.windowTabs.get(windowId) ?? [])]) this.removeTabRecord(tabId);
    this.windowTabs.delete(windowId);
    this.activeTabs.delete(windowId);
    if (this.focusedWindowId === windowId) this.focusedWindowId = undefined;
  }

  /** Tabs in popup/devtools/app windows are not part of the tree. Unknown windows are trusted. */
  ignoresWindow(windowId: number): boolean {
    return this.knownWindows.get(windowId) === false;
  }

  /** Whether `windowId` is a window we currently see open (known trackable, or holding tabs). */
  seesWindowOpen(windowId: number): boolean {
    return this.knownWindows.get(windowId) === true || this.windowTabs.has(windowId);
  }

  /** Tabs the real window `windowId` still holds, minus the ones known to be closing. */
  realTabsRemaining(windowId: number, closing?: ReadonlySet<number>): number {
    const order = this.windowTabs.get(windowId) ?? [];
    return closing ? order.filter((id) => !closing.has(id)).length : order.length;
  }
}

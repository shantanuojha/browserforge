/**
 * Restores in flight. When the tracker asks the browser for a tab or a window, the saved node
 * that must own the result is registered here first, so the `onCreated` events that arrive before
 * the API call resolves reuse the node instead of conjuring a duplicate.
 */
import type { Clock } from "@browserforge/shared";
import type { NodeId } from "../model";
import type { LiveTab } from "./types";
import { sameUrl, targetUrl } from "./url";

/**
 * A restore in flight: the saved node that must own the tab `tabs.create` is about to produce.
 * Matched by window + url when `tabs.onCreated` fires (the tab id is not known yet), then
 * confirmed by tab id once `tabs.create` resolves. Forgotten after `ADOPTION_TTL_MS` so a create
 * that never came back cannot capture an unrelated tab later.
 */
export interface TabAdoption {
  nodeId: NodeId;
  url: string;
  windowId: number | undefined;
  ts: number;
}

/** A container being reopened as a window: its saved tabs claim the window's first tabs by url. */
export interface WindowAdoption {
  nodeId: NodeId;
  urls: string[];
  /** Restrict the claim to these saved nodes (undo of a partial close). */
  only: ReadonlySet<NodeId> | undefined;
}

export const ADOPTION_TTL_MS = 30_000;

export class AdoptionRegistry {
  private tabs: TabAdoption[] = [];
  private window: WindowAdoption | null = null;

  constructor(private readonly clock: Clock) {}

  reset(): void {
    this.tabs = [];
    this.window = null;
  }

  /** Register that the next tab matching `url` in `windowId` belongs to `nodeId`. */
  expectTab(nodeId: NodeId, url: string, windowId: number | undefined): TabAdoption {
    const adoption: TabAdoption = { nodeId, url, windowId, ts: this.clock() };
    this.tabs.push(adoption);
    return adoption;
  }

  /** The restore for `nodeId` finished or failed: stop watching for its tab. */
  forgetNode(nodeId: NodeId): void {
    this.tabs = this.tabs.filter((a) => a.nodeId !== nodeId);
  }

  forget(adoption: TabAdoption): void {
    this.tabs = this.tabs.filter((a) => a !== adoption);
  }

  /** The window finished opening: whatever was not claimed by its tabs is not coming. */
  forgetWindowTabs(windowId: number): void {
    this.tabs = this.tabs.filter((a) => a.windowId !== windowId);
  }

  /** Restores still waiting for their tab, minus the ones that gave up (see `ADOPTION_TTL_MS`). */
  private pending(): TabAdoption[] {
    const cutoff = this.clock() - ADOPTION_TTL_MS;
    if (this.tabs.some((a) => a.ts < cutoff)) {
      this.tabs = this.tabs.filter((a) => a.ts >= cutoff);
    }
    return this.tabs;
  }

  /** The pending restore this freshly created tab fulfils, if any; it is consumed. */
  claimTab(tab: LiveTab): TabAdoption | undefined {
    const url = targetUrl(tab);
    const pending = this.pending();
    const index = pending.findIndex(
      (a) => (a.windowId === undefined || a.windowId === tab.windowId) && sameUrl(a.url, url),
    );
    if (index < 0) return undefined;
    const [adoption] = pending.splice(index, 1);
    return adoption;
  }

  expectWindow(adoption: WindowAdoption): void {
    this.window = adoption;
  }

  /** The window adoption, consumed: `windows.onCreated` fires once per `windows.create`. */
  takeWindow(): WindowAdoption | null {
    const adoption = this.window;
    this.window = null;
    return adoption;
  }

  clearWindow(): void {
    this.window = null;
  }
}

import type { Logger } from "@browserforge/shared";
import { classifyHost, hostFromTabUrl } from "../planner.js";
import type { ListType, Settings } from "../settings.js";
import { urlsOfTab, type OpenTab } from "./open-tabs.js";

export const BADGE_COLORS = {
  default: "#3b5bdb",
  white: "#2f9e44",
  grey: "#868e96",
  paused: "#495057",
  flash: "#e8590c",
} as const;

export const BADGE_TEXT_COLOR = "#ffffff";
export const BADGE_FLASH_MS = 4000;
export const BADGE_DEBOUNCE_MS = 400;

export interface BadgeStyle {
  text: string;
  color: string;
}

export interface SiteBadgeInput {
  enabled: boolean;
  /** Null for tabs that cannot own cookies. */
  host: string | null;
  listType: ListType | null;
  cookieCount: number;
}

const LIST_COLORS: Record<ListType, string> = {
  white: BADGE_COLORS.white,
  grey: BADGE_COLORS.grey,
};

/** What the toolbar badge shows for the site in the active tab. */
export function siteBadge(input: SiteBadgeInput): BadgeStyle {
  if (!input.host) return { text: "", color: BADGE_COLORS.default };
  if (!input.enabled) return { text: "off", color: BADGE_COLORS.paused };
  const color = input.listType ? LIST_COLORS[input.listType] : BADGE_COLORS.default;
  return { text: String(input.cookieCount), color };
}

/** Briefly shown after a cleanup when notifications are on. */
export function flashBadge(removed: number): BadgeStyle {
  return { text: `-${removed}`, color: BADGE_COLORS.flash };
}

export interface BadgePainter {
  paint(tabId: number, style: BadgeStyle): Promise<void>;
}

export interface BadgeTab extends OpenTab {
  id: number;
}

export interface BadgeControllerDeps {
  painter: BadgePainter;
  /** The given tab, or the active tab when none is given; undefined when it is gone. */
  resolveTab(tabId?: number): Promise<BadgeTab | undefined>;
  storeIdForTab(tabId: number): Promise<string>;
  countCookies(storeId: string, host: string): Promise<number>;
  loadSettings(): Promise<Settings>;
  logger: Logger;
  flashMs?: number;
  debounceMs?: number;
}

export interface BadgeController {
  refresh(tabId?: number): Promise<void>;
  /** Coalesces bursts of events (cookie changes, focus changes) into one refresh. */
  refreshDebounced(): void;
  flash(removed: number): Promise<void>;
}

export function createBadgeController(deps: BadgeControllerDeps): BadgeController {
  const flashMs = deps.flashMs ?? BADGE_FLASH_MS;
  const debounceMs = deps.debounceMs ?? BADGE_DEBOUNCE_MS;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  async function styleFor(tab: BadgeTab, host: string, settings: Settings): Promise<BadgeStyle> {
    const storeId = await deps.storeIdForTab(tab.id);
    const cookieCount = await deps.countCookies(storeId, host);
    const listType = classifyHost(host, storeId, settings.lists);
    return siteBadge({ enabled: settings.enabled, host, listType, cookieCount });
  }

  async function refresh(tabId?: number): Promise<void> {
    const tab = await deps.resolveTab(tabId);
    if (!tab) return;
    const host = hostFromTabUrl(urlsOfTab(tab)[0]);
    const settings = await deps.loadSettings();
    if (!host || !settings.enabled) {
      await deps.painter.paint(
        tab.id,
        siteBadge({ enabled: settings.enabled, host, listType: null, cookieCount: 0 }),
      );
      return;
    }
    try {
      await deps.painter.paint(tab.id, await styleFor(tab, host, settings));
    } catch (error) {
      deps.logger.warn("badge update failed", error);
    }
  }

  function refreshDebounced(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void refresh();
    }, debounceMs);
  }

  async function flash(removed: number): Promise<void> {
    const tab = await deps.resolveTab();
    if (!tab) return;
    await deps.painter.paint(tab.id, flashBadge(removed));
    setTimeout(() => void refresh(), flashMs);
  }

  return { refresh, refreshDebounced, flash };
}

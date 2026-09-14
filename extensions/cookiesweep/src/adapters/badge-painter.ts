import { BADGE_TEXT_COLOR, type BadgePainter } from "../lib/background/badge.js";
import { getActionApi } from "./extension-api.js";

/** Paints the toolbar badge through `action` / `browserAction`; a closed tab is not an error. */
export const browserBadgePainter: BadgePainter = {
  async paint(tabId, style) {
    const action = getActionApi();
    if (!action) return;
    try {
      await action.setBadgeText({ text: style.text, tabId });
      await action.setBadgeBackgroundColor({ color: style.color, tabId });
      if (typeof action.setBadgeTextColor === "function") {
        await action.setBadgeTextColor({ color: BADGE_TEXT_COLOR, tabId });
      }
    } catch {
      // Tab may have been closed in the meantime.
    }
  },
};

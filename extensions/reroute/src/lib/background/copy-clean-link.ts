import type { DnrRule } from "../dnr";
import type { CopyTextMessage } from "../messages";
import { cleanUrl } from "../tracking/clean";
import type { ActivityRecorder } from "./activity-recorder";

/** Delivers a message to the content script of a tab (optionally one frame of it). */
export interface ContentScriptMessenger {
  sendToTab(tabId: number, message: CopyTextMessage, frameId?: number): Promise<void>;
}

export interface CopyCleanLinkRequest {
  url: string;
  tabId: number;
  frameId?: number;
}

export interface CopyCleanLinkDeps {
  messenger: ContentScriptMessenger;
  recorder: ActivityRecorder;
  loadTrackingRules(): Promise<DnrRule[]>;
  isTrackingEnabled(): boolean;
}

/**
 * "Copy clean link": the background cannot touch the clipboard, so the cleaned URL is sent to
 * the content script of the tab the menu was opened in, which writes it.
 */
export function createCopyCleanLink(deps: CopyCleanLinkDeps) {
  return async function copyCleanLink(request: CopyCleanLinkRequest): Promise<void> {
    const rules = deps.isTrackingEnabled() ? await deps.loadTrackingRules() : [];
    const cleaned = cleanUrl(request.url, rules);
    try {
      await deps.messenger.sendToTab(
        request.tabId,
        { type: "reroute:copy-text", text: cleaned.url },
        request.frameId,
      );
    } catch {
      // Tab without our content script (browser page, or tab opened before install).
      await deps.recorder.recordError(
        "Copy clean link: page cannot receive the clipboard message; reload the tab",
        { from: request.url, to: cleaned.url },
      );
    }
  };
}

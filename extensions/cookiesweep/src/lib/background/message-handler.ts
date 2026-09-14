import type { CleanupSummary, Message, MessageResponse } from "../messages.js";
import { hostFromTabUrl } from "../planner.js";
import { EMPTY_SUMMARY } from "./activity.js";

export interface MessageHandlerDeps {
  cleanSite(host: string, tabId?: number): Promise<CleanupSummary>;
  /** A forced full sweep (greylist expired too). */
  cleanAll(): Promise<CleanupSummary | null>;
  refreshBadge(): Promise<void>;
}

/** Request/response API for the popup and options page. */
export function createMessageHandler(deps: MessageHandlerDeps) {
  return async function handleMessage(message: Message): Promise<MessageResponse> {
    switch (message.type) {
      case "clean-site": {
        const host = hostFromTabUrl(message.host);
        if (!host) return { ok: false, error: "This page cannot have cookies." };
        return { ok: true, summary: await deps.cleanSite(host, message.tabId) };
      }
      case "clean-all":
        return { ok: true, summary: (await deps.cleanAll()) ?? EMPTY_SUMMARY };
      case "refresh-badge":
        await deps.refreshBadge();
        return { ok: true };
    }
  };
}

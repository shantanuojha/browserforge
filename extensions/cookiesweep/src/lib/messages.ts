import { browser } from "wxt/browser";

/**
 * Messages from the popup / options page to the background. All cleanups go through
 * the background so the activity log and badge stay consistent.
 */

export type Message =
  | { type: "clean-site"; host: string; tabId?: number }
  | { type: "clean-all" }
  | { type: "refresh-badge" };

export interface CleanupSummary {
  cookiesRemoved: number;
  siteDataDomains: number;
  domains: string[];
}

export type MessageResponse = { ok: true; summary?: CleanupSummary } | { ok: false; error: string };

export async function sendMessage(message: Message): Promise<MessageResponse> {
  try {
    const response = (await browser.runtime.sendMessage(message)) as MessageResponse | undefined;
    if (!response) return { ok: false, error: "No response from the background service." };
    return response;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "clean-site" || type === "clean-all" || type === "refresh-badge";
}

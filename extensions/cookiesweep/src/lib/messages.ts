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

const MESSAGE_TYPES: ReadonlySet<string> = new Set(["clean-site", "clean-all", "refresh-badge"]);

export function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && MESSAGE_TYPES.has(type);
}

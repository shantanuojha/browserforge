/** Runtime message contracts between background, popup, options and the content script. */

export interface CopyTextMessage {
  type: "reroute:copy-text";
  text: string;
}

export interface GetStatusMessage {
  type: "reroute:get-status";
}

export interface RebuildMessage {
  type: "reroute:rebuild";
}

export type Message = CopyTextMessage | GetStatusMessage | RebuildMessage;

export interface StatusResponse {
  enabledRules: number;
  dnrRules: number;
  jsOnlyRuleIds: string[];
  jsOnlyReasons: Record<string, string>;
  trackingEnabled: boolean;
  lastError: string | null;
  lastRebuildAt: number;
}

export function isMessage(value: unknown): value is Message {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string" &&
    (value as { type: string }).type.startsWith("reroute:")
  );
}

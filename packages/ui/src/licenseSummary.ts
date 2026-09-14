/** Pure presentation rules for licence states: banners, detail rows, restore eligibility. */
import type { LicenseInvalidReason, LicenseState } from "@browserforge/licensing";
import type { CalloutTone } from "./Callout.js";
import type { KeyValueItem } from "./KeyValueList.js";

const INVALID_REASON_TEXT: Record<LicenseInvalidReason, string> = {
  expired: "This licence has expired. Renew it, then choose Restore purchase.",
  disabled: "This licence has been disabled by the store.",
  wrong_product: "This key belongs to a different BrowserForge product.",
  not_found: "This key no longer exists on the store.",
  deactivated: "This browser was deactivated from another device.",
  unknown: "The licence could not be verified.",
};

export interface LicenseSummary {
  tone: CalloutTone;
  title: string;
  text?: string;
}

export function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function summarizeFreeState(state: Extract<LicenseState, { kind: "free" }>): LicenseSummary | null {
  if (state.reason === "grace_expired") {
    return {
      tone: "warning",
      title: "Your licence could not be confirmed for a while.",
      text: "Reconnect to the internet and choose Restore purchase.",
    };
  }
  if (state.reason === "deactivated") {
    return {
      tone: "info",
      title: "This browser was deactivated.",
      text: "The seat is free for another profile or device.",
    };
  }
  return null;
}

/** Human-readable summary of a licence state for banners. `null` when nothing needs saying. */
export function summarizeLicenseState(state: LicenseState | null): LicenseSummary | null {
  if (!state) return null;
  switch (state.kind) {
    case "pro":
      return { tone: "success", title: "Pro is active in this browser." };
    case "grace":
      return {
        tone: "warning",
        title: "Could not reach the licence server.",
        text: `Pro stays on until ${formatDate(state.graceEndsAt)}. Reconnect to keep it.`,
      };
    case "invalid":
      return {
        tone: "danger",
        title: "Licence not valid.",
        text: INVALID_REASON_TEXT[state.reason],
      };
    case "free":
      return summarizeFreeState(state);
  }
}

/** True when a key is on disk that "Restore purchase" can re-validate instead of opening the store. */
export function hasRestorableKey(state: LicenseState | null): boolean {
  return state?.kind === "invalid" || (state?.kind === "free" && state.reason === "grace_expired");
}

/** Detail rows shown to a Pro (or grace) user; empty for every other state. */
export function licenseDetailItems(state: LicenseState | null): KeyValueItem[] {
  if (!state || (state.kind !== "pro" && state.kind !== "grace")) return [];
  const items: KeyValueItem[] = [{ key: "Licence key", value: state.key, mono: true }];
  if (state.email) items.push({ key: "Email", value: state.email });
  items.push(
    { key: "Expires", value: state.expiresAt ? formatDate(state.expiresAt) : "Never" },
    { key: "Last checked", value: formatDate(state.lastValidatedAt) },
    { key: "This browser", value: state.instanceName, mono: true },
  );
  return items;
}

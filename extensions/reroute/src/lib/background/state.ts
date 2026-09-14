import type { Rule } from "../rules/model";
import { DEFAULT_SETTINGS, type Settings } from "../settings";
import type { StatusResponse } from "../messages";

/** Everything the background knows between events. Mutated only by the background service. */
export interface BackgroundState {
  rules: Rule[];
  enabledRules: Rule[];
  allowlist: string[];
  settings: Settings;
  /** Rules the JS fallback must handle on onBeforeNavigate (everything is JS on history-state). */
  jsOnlyRuleIds: Set<string>;
  jsOnlyReasons: Record<string, string>;
  dnrRuleCount: number;
  lastError: string | null;
  lastRebuildAt: number;
}

export function initialState(): BackgroundState {
  return {
    rules: [],
    enabledRules: [],
    allowlist: [],
    settings: { ...DEFAULT_SETTINGS },
    jsOnlyRuleIds: new Set(),
    jsOnlyReasons: {},
    dnrRuleCount: 0,
    lastError: null,
    lastRebuildAt: 0,
  };
}

/** The read-only view the popup and options page ask for. */
export function toStatusResponse(state: BackgroundState): StatusResponse {
  return {
    enabledRules: state.enabledRules.length,
    dnrRules: state.dnrRuleCount,
    jsOnlyRuleIds: [...state.jsOnlyRuleIds],
    jsOnlyReasons: state.jsOnlyReasons,
    trackingEnabled: state.settings.trackingEnabled,
    lastError: state.lastError,
    lastRebuildAt: state.lastRebuildAt,
  };
}

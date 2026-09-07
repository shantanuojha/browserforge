/**
 * Structural types for `declarativeNetRequest` rules. They mirror the subset of
 * `chrome.declarativeNetRequest.Rule` that Reroute produces and are assignable
 * to the browser types, while staying importable from plain Node scripts.
 */

export type DnrResourceType =
  | "main_frame"
  | "sub_frame"
  | "stylesheet"
  | "script"
  | "image"
  | "font"
  | "object"
  | "xmlhttprequest"
  | "ping"
  | "csp_report"
  | "media"
  | "websocket"
  | "webtransport"
  | "webbundle"
  | "other";

export interface DnrCondition {
  regexFilter?: string;
  urlFilter?: string;
  requestDomains?: string[];
  excludedRequestDomains?: string[];
  resourceTypes?: DnrResourceType[];
  excludedResourceTypes?: DnrResourceType[];
  isUrlFilterCaseSensitive?: boolean;
}

export interface DnrQueryTransform {
  removeParams?: string[];
  addOrReplaceParams?: { key: string; value: string; replaceOnly?: boolean }[];
}

export interface DnrRedirect {
  url?: string;
  regexSubstitution?: string;
  transform?: {
    queryTransform?: DnrQueryTransform;
    scheme?: string;
    host?: string;
    path?: string;
    query?: string;
    fragment?: string;
  };
}

export interface DnrAction {
  type: "redirect" | "allow" | "block" | "upgradeScheme" | "allowAllRequests" | "modifyHeaders";
  redirect?: DnrRedirect;
}

export interface DnrRule {
  id: number;
  priority?: number;
  condition: DnrCondition;
  action: DnrAction;
}

/** Chrome's documented static/dynamic limits, kept here so scripts and tests share them. */
export const DNR_LIMITS = {
  maxStaticRulesPerRuleset: 30_000,
  maxRegexRules: 1_000,
  maxDynamicRules: 5_000,
} as const;

/**
 * Priority bands. Higher wins. Allow rules only suppress rules with a lower or
 * equal priority, so the ordering below encodes the product semantics:
 *
 *   tracking removeParams (static)      1
 *   tracking exceptions (static allow)  2   suppress only tracking cleanup
 *   user redirect rules (dynamic)       100..  never suppressed by tracking exceptions
 *   per-site allowlist (dynamic allow)  100000 turns everything off for a host
 */
export const DNR_PRIORITY = {
  tracking: 1,
  trackingException: 2,
  userRuleBase: 100,
  siteAllow: 100_000,
} as const;

/** Dynamic-rule id ranges (dynamic ids only need to be unique among themselves). */
export const DNR_ID_RANGE = {
  siteAllowBase: 1,
  userRuleBase: 10_000,
} as const;

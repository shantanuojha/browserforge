/**
 * Compiles user rules and the per-site allowlist into `declarativeNetRequest` rules.
 * Pure: the browser's acceptance of the result is checked by the rule deployer.
 */

import type { DnrResourceType, DnrRule } from "../dnr";
import { DNR_PRIORITY } from "../dnr";
import { countCaptureGroups, includeRegexSource } from "./engine";
import { RESOURCE_TYPES, type Rule } from "./model";
import { isRE2Compatible } from "./re2";

export interface CompiledRules {
  dnrRules: DnrRule[];
  /** Rule ids that must be handled by the JS fallback (transforms, excludes, non-RE2 regex...). */
  jsOnlyRuleIds: string[];
  /** rule.id -> reason it is JS-only (for the UI). */
  jsOnlyReasons: Record<string, string>;
  /** rule.id -> DNR rule id, for the "what fired" log. */
  dnrIdByRuleId: Record<string, number>;
}

/** True when `|` occurs outside every group, class and escape, i.e. `^a|b$` anchors only one branch. */
export function hasTopLevelAlternation(source: string): boolean {
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "|" && depth === 0) return true;
  }
  return false;
}

/** Wraps a regex so that DNR's "replace the first match" becomes "replace the whole URL". */
export function anchorForDNR(source: string): string {
  // A leading `^` / trailing `$` only anchors its own branch when there is a top-level `|`.
  const alternation = hasTopLevelAlternation(source);
  const startsAnchored = !alternation && source.startsWith("^");
  const endsAnchored = !alternation && /(^|[^\\])(\\\\)*\$$/.test(source);
  if (startsAnchored && endsAnchored) return source;
  const head = startsAnchored ? "" : "^.*?";
  const tail = endsAnchored ? "" : ".*$";
  return `${head}(?:${source})${tail}`;
}

/** `$1` -> `\1`. Returns null when the template cannot be expressed. */
export function toRegexSubstitution(template: string, groupCount: number): string | null {
  if (template.includes("\\")) return null;
  let bad = false;
  const out = template.replace(/\$([1-9])/g, (_m, d: string) => {
    if (Number(d) > groupCount) bad = true;
    return `\\${d}`;
  });
  return bad ? null : out;
}

/** Why a rule cannot be a DNR rule, or null if it can. */
export function dnrIneligibilityReason(rule: Rule): string | null {
  if (rule.transforms.length > 0) return "uses transforms";
  if (rule.exclude.length > 0) return "has exclude patterns";
  const source = includeRegexSource(rule);
  if (!isRE2Compatible(source)) return "regex is outside the RE2 subset";
  if (toRegexSubstitution(rule.redirectTo, countCaptureGroups(source)) === null)
    return "redirect target cannot be expressed as a regexSubstitution";
  return null;
}

export function dnrResourceTypes(rule: Rule): DnrResourceType[] {
  if (rule.applyTo === "navigation") return ["main_frame"];
  return rule.resourceTypes.length > 0 ? [...rule.resourceTypes] : [...RESOURCE_TYPES];
}

function toRedirectRule(rule: Rule, id: number, priority: number): DnrRule | null {
  const source = includeRegexSource(rule);
  const substitution = toRegexSubstitution(rule.redirectTo, countCaptureGroups(source));
  if (substitution === null) return null; // unreachable: covered by dnrIneligibilityReason
  return {
    id,
    priority,
    condition: {
      regexFilter: anchorForDNR(source),
      resourceTypes: dnrResourceTypes(rule),
      isUrlFilterCaseSensitive: false,
    },
    action: { type: "redirect", redirect: { regexSubstitution: substitution } },
  };
}

/**
 * Compiles enabled rules to DNR redirect rules. Earlier rules get a higher
 * priority so first-match-wins survives the translation. Disabled rules are
 * skipped entirely; ineligible rules are reported in `jsOnlyRuleIds`.
 */
export function compileToDNR(rules: readonly Rule[], idBase: number): CompiledRules {
  const enabled = rules.filter((r) => r.enabled);
  const compiled: CompiledRules = {
    dnrRules: [],
    jsOnlyRuleIds: [],
    jsOnlyReasons: {},
    dnrIdByRuleId: {},
  };

  enabled.forEach((rule, i) => {
    const reason = dnrIneligibilityReason(rule);
    if (reason) {
      compiled.jsOnlyRuleIds.push(rule.id);
      compiled.jsOnlyReasons[rule.id] = reason;
      return;
    }
    const id = idBase + i;
    const priority = DNR_PRIORITY.userRuleBase + (enabled.length - 1 - i);
    const dnrRule = toRedirectRule(rule, id, priority);
    if (!dnrRule) return;
    compiled.dnrIdByRuleId[rule.id] = id;
    compiled.dnrRules.push(dnrRule);
  });

  return compiled;
}

const escapeForRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface AllowlistGroups {
  /** `host`: the exact host only. */
  exact: Set<string>;
  /** `*.host`: subdomains only. */
  subdomains: Set<string>;
  /** `*host`: apex and subdomains. */
  domains: Set<string>;
}

function groupAllowlistPatterns(patterns: readonly string[]): AllowlistGroups {
  const groups: AllowlistGroups = { exact: new Set(), subdomains: new Set(), domains: new Set() };
  for (const raw of patterns) {
    const pattern = raw.trim().toLowerCase();
    const host = pattern.replace(/^\*\.?/, "").replace(/^\.+|\.+$/g, "");
    if (!host) continue;
    if (pattern.startsWith("*.")) groups.subdomains.add(host);
    else if (pattern.startsWith("*")) groups.domains.add(host);
    else groups.exact.add(host);
  }
  return groups;
}

const hostGroup = (hosts: Set<string>) => `(?:${[...hosts].map(escapeForRegex).join("|")})`;

/**
 * Per-site allowlist -> high-priority allow rules with the same semantics as
 * `hostMatchesPattern`: `host` is the exact host, `*.host` its subdomains only,
 * `*host` both. `requestDomains` always includes subdomains, so only the last
 * form can use it; the other two become one RE2 regex each over the URL.
 */
export function allowlistToDNR(patterns: readonly string[], idBase: number): DnrRule[] {
  const { exact, subdomains, domains } = groupAllowlistPatterns(patterns);
  const base = { priority: DNR_PRIORITY.siteAllow, action: { type: "allow" } as const };
  const resourceTypes = [...RESOURCE_TYPES];
  const regexRule = (id: number, regexFilter: string): DnrRule => ({
    ...base,
    id,
    condition: { regexFilter, isUrlFilterCaseSensitive: false, resourceTypes },
  });

  const rules: DnrRule[] = [];
  if (domains.size > 0) {
    rules.push({ ...base, id: idBase, condition: { requestDomains: [...domains], resourceTypes } });
  }
  if (exact.size > 0) {
    rules.push(regexRule(idBase + 1, `^[^:/?#]+://${hostGroup(exact)}(?::\\d+)?/`));
  }
  if (subdomains.size > 0) {
    rules.push(regexRule(idBase + 2, `^[^:/?#]+://[^/?#]*\\.${hostGroup(subdomains)}(?::\\d+)?/`));
  }
  return rules;
}

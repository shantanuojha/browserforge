/**
 * Reroute rule model (see README.md). Plain types plus hand-rolled validators;
 * this package deliberately has no schema library dependency.
 */

import { errorMessage, isRecord } from "@browserforge/shared";

export const MATCH_TYPES = ["wildcard", "regex"] as const;
export type MatchType = (typeof MATCH_TYPES)[number];

export const TRANSFORMS = [
  "decodeURIComponent",
  "encodeURIComponent",
  "atob",
  "btoa",
  "lower",
  "upper",
] as const;
export type Transform = (typeof TRANSFORMS)[number];

export const APPLY_TO = ["navigation", "all"] as const;
export type ApplyTo = (typeof APPLY_TO)[number];

/**
 * Resource types accepted in `Rule.resourceTypes`. This is the cross-browser
 * subset of `declarativeNetRequest.ResourceType` (Firefox lacks webtransport /
 * webbundle / csp_report).
 */
export const RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "media",
  "websocket",
  "other",
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export interface Rule {
  /** Stable unique id (any non-empty string; we generate `r_<random>`). */
  id: string;
  name: string;
  enabled: boolean;
  matchType: MatchType;
  /** Wildcard pattern (`*` captures) or JavaScript regex source. */
  include: string;
  /** Patterns (same matchType) that veto a match. */
  exclude: string[];
  /** Target; `$1`..`$9` insert capture groups (after transforms). */
  redirectTo: string;
  /** Only meaningful for `applyTo: "all"`. Empty means every resource type. */
  resourceTypes: ResourceType[];
  transforms: Transform[];
  /** `navigation` = top-level navigations + history-state (SPA); `all` = every request type listed. */
  applyTo: ApplyTo;
}

/** Envelope used by our own import/export JSON. */
export interface RuleSetDocument {
  app: "reroute";
  version: 1;
  exportedAt?: string;
  rules: Rule[];
}

export const RULESET_DOCUMENT_VERSION = 1 as const;

export function isMatchType(v: unknown): v is MatchType {
  return typeof v === "string" && (MATCH_TYPES as readonly string[]).includes(v);
}
export function isTransform(v: unknown): v is Transform {
  return typeof v === "string" && (TRANSFORMS as readonly string[]).includes(v);
}
export function isApplyTo(v: unknown): v is ApplyTo {
  return typeof v === "string" && (APPLY_TO as readonly string[]).includes(v);
}
export function isResourceType(v: unknown): v is ResourceType {
  return typeof v === "string" && (RESOURCE_TYPES as readonly string[]).includes(v);
}

/** `undefined` reads as an empty list; anything that is not a string array is `null`. */
function stringArray(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  return v.every((x) => typeof x === "string") ? (v as string[]) : null;
}

export function generateRuleId(): string {
  const bytes = new Uint8Array(6);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return "r_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createRule(partial: Partial<Rule> = {}): Rule {
  return {
    id: partial.id ?? generateRuleId(),
    name: partial.name ?? "",
    enabled: partial.enabled ?? true,
    matchType: partial.matchType ?? "wildcard",
    include: partial.include ?? "",
    exclude: partial.exclude ?? [],
    redirectTo: partial.redirectTo ?? "",
    resourceTypes: partial.resourceTypes ?? [],
    transforms: partial.transforms ?? [],
    applyTo: partial.applyTo ?? "navigation",
  };
}

export interface ValidationResult<T> {
  ok: true;
  value: T;
}
export interface ValidationError {
  ok: false;
  error: string;
}
export type Validation<T> = ValidationResult<T> | ValidationError;

const invalid = (error: string): ValidationError => ({ ok: false, error });
const valid = <T>(value: T): ValidationResult<T> => ({ ok: true, value });

type IdentityFields = Pick<Rule, "id" | "name" | "enabled" | "matchType" | "include">;
type BehaviourFields = Pick<
  Rule,
  "exclude" | "redirectTo" | "resourceTypes" | "transforms" | "applyTo"
>;

/** id, name, enabled, matchType, include: who the rule is and what it matches. */
function parseIdentityFields(
  input: Record<string, unknown>,
  where: string,
): Validation<IdentityFields> {
  const id = input.id === undefined ? generateRuleId() : input.id;
  if (typeof id !== "string" || id.length === 0) {
    return invalid(`${where}: id must be a non-empty string`);
  }
  const name = input.name === undefined ? "" : input.name;
  if (typeof name !== "string") return invalid(`${where}: name must be a string`);

  const enabled = input.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== "boolean") return invalid(`${where}: enabled must be boolean`);

  const matchType = input.matchType === undefined ? "wildcard" : input.matchType;
  if (!isMatchType(matchType)) return invalid(`${where}: matchType must be "wildcard" or "regex"`);

  const include = input.include;
  if (typeof include !== "string" || include.length === 0) {
    return invalid(`${where}: include must be a non-empty string`);
  }
  return valid({ id, name, enabled, matchType, include });
}

/** exclude, redirectTo, resourceTypes, transforms, applyTo: what the rule does with a match. */
function parseBehaviourFields(
  input: Record<string, unknown>,
  where: string,
): Validation<BehaviourFields> {
  const exclude = stringArray(input.exclude);
  if (exclude === null) return invalid(`${where}: exclude must be a string array`);

  const redirectTo = input.redirectTo;
  if (typeof redirectTo !== "string") return invalid(`${where}: redirectTo must be a string`);

  const resourceTypes = stringArray(input.resourceTypes);
  if (resourceTypes === null || !resourceTypes.every(isResourceType)) {
    return invalid(`${where}: resourceTypes contains an unknown type`);
  }
  const transforms = stringArray(input.transforms);
  if (transforms === null || !transforms.every(isTransform)) {
    return invalid(`${where}: transforms contains an unknown transform`);
  }
  const applyTo = input.applyTo === undefined ? "navigation" : input.applyTo;
  if (!isApplyTo(applyTo)) return invalid(`${where}: applyTo must be "navigation" or "all"`);

  return valid({ exclude, redirectTo, resourceTypes, transforms, applyTo });
}

/**
 * Validates and normalises one rule object. Unknown keys are dropped; missing
 * optional arrays default to empty; missing `id` gets generated.
 */
export function parseRule(input: unknown, index = 0): Validation<Rule> {
  const where = `rule[${index}]`;
  if (!isRecord(input)) return invalid(`${where}: not an object`);

  const identity = parseIdentityFields(input, where);
  if (!identity.ok) return identity;
  const behaviour = parseBehaviourFields(input, where);
  if (!behaviour.ok) return behaviour;

  if (identity.value.matchType === "regex") {
    const sources = [identity.value.include, ...behaviour.value.exclude];
    const bad = sources.find((src) => !isValidRegexSource(src));
    if (bad !== undefined) return invalid(`${where}: invalid regex "${bad}"`);
  }

  return valid({
    ...identity.value,
    ...behaviour.value,
    exclude: behaviour.value.exclude.filter((e) => e.length > 0),
  });
}

export function isValidRegexSource(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

export interface ParsedRules {
  rules: Rule[];
  errors: string[];
}

/** The list of candidate rules inside any of the accepted document shapes, or `null`. */
function ruleListOf(input: unknown): unknown[] | null {
  if (Array.isArray(input)) return input;
  if (isRecord(input) && Array.isArray(input.rules)) return input.rules;
  if (isRecord(input) && typeof input.include === "string") return [input];
  return null;
}

/** Accepts a RuleSetDocument, a bare array of rules, or a single rule. */
export function parseRules(input: unknown): ParsedRules {
  const list = ruleListOf(input);
  if (!list) {
    return { rules: [], errors: ["Expected a rules document, an array of rules, or a rule"] };
  }
  const rules: Rule[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  list.forEach((item, i) => {
    const res = parseRule(item, i);
    if (!res.ok) {
      errors.push(res.error);
      return;
    }
    const rule = seen.has(res.value.id) ? { ...res.value, id: generateRuleId() } : res.value;
    seen.add(rule.id);
    rules.push(rule);
  });
  return { rules, errors };
}

/**
 * Appends imported rules to the existing list. An incoming rule whose id is
 * already present (re-importing one's own export) gets a fresh id, so the list
 * never holds two rules with the same id.
 */
export function appendRules(existing: readonly Rule[], incoming: readonly Rule[]): Rule[] {
  const seen = new Set(existing.map((r) => r.id));
  const out = [...existing];
  for (const rule of incoming) {
    const next = seen.has(rule.id) ? { ...rule, id: generateRuleId() } : rule;
    seen.add(next.id);
    out.push(next);
  }
  return out;
}

export function parseRulesJson(text: string): ParsedRules {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { rules: [], errors: [`Invalid JSON: ${errorMessage(e)}`] };
  }
  return parseRules(json);
}

export function toRuleSetDocument(rules: readonly Rule[]): RuleSetDocument {
  return {
    app: "reroute",
    version: RULESET_DOCUMENT_VERSION,
    exportedAt: new Date().toISOString(),
    rules: rules.map((r) => ({ ...r })),
  };
}

export function serializeRules(rules: readonly Rule[]): string {
  return JSON.stringify(toRuleSetDocument(rules), null, 2);
}

/** Human-readable summary for lists. */
export function describeRule(rule: Rule): string {
  if (rule.name.trim()) return rule.name.trim();
  return `${rule.include} -> ${rule.redirectTo}`;
}

/**
 * Reroute rule model (see README.md). Plain types plus hand-rolled validators;
 * this package deliberately has no schema library dependency.
 */

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

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

/**
 * Validates and normalises one rule object. Unknown keys are dropped; missing
 * optional arrays default to empty; missing `id` gets generated.
 */
export function parseRule(input: unknown, index = 0): Validation<Rule> {
  const where = `rule[${index}]`;
  if (!isRecord(input)) return { ok: false, error: `${where}: not an object` };

  const id = input.id === undefined ? generateRuleId() : input.id;
  if (typeof id !== "string" || id.length === 0)
    return { ok: false, error: `${where}: id must be a non-empty string` };

  const name = input.name === undefined ? "" : input.name;
  if (typeof name !== "string") return { ok: false, error: `${where}: name must be a string` };

  const enabled = input.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== "boolean")
    return { ok: false, error: `${where}: enabled must be boolean` };

  const matchType = input.matchType === undefined ? "wildcard" : input.matchType;
  if (!isMatchType(matchType))
    return { ok: false, error: `${where}: matchType must be "wildcard" or "regex"` };

  const include = input.include;
  if (typeof include !== "string" || include.length === 0)
    return { ok: false, error: `${where}: include must be a non-empty string` };

  const exclude = stringArray(input.exclude);
  if (exclude === null) return { ok: false, error: `${where}: exclude must be a string array` };

  const redirectTo = input.redirectTo;
  if (typeof redirectTo !== "string")
    return { ok: false, error: `${where}: redirectTo must be a string` };

  const resourceTypesRaw = stringArray(input.resourceTypes);
  if (resourceTypesRaw === null || !resourceTypesRaw.every(isResourceType))
    return { ok: false, error: `${where}: resourceTypes contains an unknown type` };

  const transformsRaw = stringArray(input.transforms);
  if (transformsRaw === null || !transformsRaw.every(isTransform))
    return { ok: false, error: `${where}: transforms contains an unknown transform` };

  const applyTo = input.applyTo === undefined ? "navigation" : input.applyTo;
  if (!isApplyTo(applyTo))
    return { ok: false, error: `${where}: applyTo must be "navigation" or "all"` };

  if (matchType === "regex") {
    const bad = [include, ...exclude].find((src) => !isValidRegexSource(src));
    if (bad !== undefined) return { ok: false, error: `${where}: invalid regex "${bad}"` };
  }

  return {
    ok: true,
    value: {
      id,
      name,
      enabled,
      matchType,
      include,
      exclude: exclude.filter((e) => e.length > 0),
      redirectTo,
      resourceTypes: resourceTypesRaw as ResourceType[],
      transforms: transformsRaw as Transform[],
      applyTo,
    },
  };
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

/** Accepts a RuleSetDocument, a bare array of rules, or a single rule. */
export function parseRules(input: unknown): ParsedRules {
  let list: unknown[];
  if (Array.isArray(input)) list = input;
  else if (isRecord(input) && Array.isArray(input.rules)) list = input.rules;
  else if (isRecord(input) && typeof input.include === "string") list = [input];
  else return { rules: [], errors: ["Expected a rules document, an array of rules, or a rule"] };

  const rules: Rule[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  list.forEach((item, i) => {
    const res = parseRule(item, i);
    if (!res.ok) {
      errors.push(res.error);
      return;
    }
    let rule = res.value;
    if (seen.has(rule.id)) rule = { ...rule, id: generateRuleId() };
    seen.add(rule.id);
    rules.push(rule);
  });
  return { rules, errors };
}

export function parseRulesJson(text: string): ParsedRules {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { rules: [], errors: [`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`] };
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

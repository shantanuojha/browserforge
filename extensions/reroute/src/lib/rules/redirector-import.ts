/**
 * Importer for Redirector's JSON export format.
 *
 * {
 *   "createdBy": "Redirector v3.5.3", "createdAt": "...",
 *   "redirects": [{
 *     "description", "exampleUrl", "exampleResult", "error",
 *     "includePattern", "excludePattern", "patternDesc", "redirectUrl",
 *     "patternType": "W" | "R",
 *     "processMatches": "noProcessing" | "urlDecode" | "doubleUrlDecode" | "urlEncode" | "base64decode",
 *     "unescapeMatches"?: boolean, "escapeMatches"?: boolean,   // pre-3.0 exports, when processMatches is absent
 *     "disabled": boolean, "grouped": boolean,
 *     "appliesTo": ["main_frame", "sub_frame", "stylesheet", "script", "image", "imageset",
 *                   "object", "xmlhttprequest", "history", "other"]
 *   }]
 * }
 */

import { errorMessage, isRecord } from "@browserforge/shared";
import {
  createRule,
  isResourceType,
  isValidRegexSource,
  type MatchType,
  type ResourceType,
  type Rule,
  type Transform,
} from "./model";

export interface RedirectorImportItem {
  rule: Rule;
  warnings: string[];
}

export interface RedirectorImportResult {
  items: RedirectorImportItem[];
  errors: string[];
  source: string;
}

/**
 * Redirector's `_includeMatch` processing. `base64decode` first unescapes a
 * capture that contains `%` (padding usually arrives as `%3D`), then atob;
 * `decodeURIComponent` is the identity on captures without `%`, so it is applied
 * unconditionally. `base64encode` is not a Redirector value but is accepted.
 */
const PROCESS_MATCHES: Record<string, Transform[]> = {
  noProcessing: [],
  urlDecode: ["decodeURIComponent"],
  doubleUrlDecode: ["decodeURIComponent", "decodeURIComponent"],
  urlEncode: ["encodeURIComponent"],
  base64decode: ["decodeURIComponent", "atob"],
  base64encode: ["btoa"],
};

/** Redirector type names -> ours. `history` is folded into applyTo=navigation. */
const REDIRECTOR_TYPES: Record<string, ResourceType | null> = {
  main_frame: "main_frame",
  sub_frame: "sub_frame",
  stylesheet: "stylesheet",
  script: "script",
  image: "image",
  imageset: "image",
  object: "object",
  xmlhttprequest: "xmlhttprequest",
  history: null,
  other: "other",
};

/** Collects non-fatal notes while one redirect is converted. */
type Warn = (message: string) => void;

function readMatchType(patternType: unknown): MatchType | null {
  if (patternType === "W" || patternType === undefined) return "wildcard";
  if (patternType === "R") return "regex";
  return null;
}

function readExclude(excludePattern: unknown, matchType: MatchType, warn: Warn): string[] {
  if (typeof excludePattern !== "string" || excludePattern.length === 0) return [];
  if (matchType === "regex" && !isValidRegexSource(excludePattern)) {
    warn("excludePattern is not a valid regex and was dropped");
    return [];
  }
  return [excludePattern];
}

/** Own-property lookup so `"constructor"` and friends do not resolve to prototype members. */
function lookup<T>(table: Record<string, T>, key: unknown): T | undefined {
  return typeof key === "string" && Object.hasOwn(table, key) ? table[key] : undefined;
}

function readTransforms(input: Record<string, unknown>, warn: Warn): Transform[] {
  if (input.processMatches !== undefined) {
    const mapped = lookup(PROCESS_MATCHES, input.processMatches);
    if (mapped) return mapped;
    warn(`unknown processMatches ${JSON.stringify(input.processMatches)}; no transform applied`);
    return [];
  }
  if (input.unescapeMatches === true) return PROCESS_MATCHES.urlDecode!;
  if (input.escapeMatches === true) return PROCESS_MATCHES.urlEncode!;
  return [];
}

function mapResourceTypes(types: readonly string[], warn: Warn): ResourceType[] {
  const seen = new Set<ResourceType>();
  for (const type of types) {
    const mapped = lookup(REDIRECTOR_TYPES, type);
    if (mapped === undefined) {
      if (isResourceType(type)) seen.add(type);
      else warn(`unknown appliesTo type "${type}" was dropped`);
    } else if (mapped !== null) {
      seen.add(mapped);
    } else if (type === "history") {
      seen.add("main_frame");
    }
  }
  return [...seen];
}

/**
 * Redirector's `appliesTo`. Only `main_frame`/`history` (or nothing) means a plain navigation
 * rule; anything else becomes an `all` rule listing the mapped resource types.
 */
function readAppliesTo(appliesTo: unknown, warn: Warn): Pick<Rule, "applyTo" | "resourceTypes"> {
  if (!Array.isArray(appliesTo) || appliesTo.length === 0) {
    return { applyTo: "navigation", resourceTypes: [] };
  }
  const types = appliesTo.filter((x): x is string => typeof x === "string");
  const nonNavigation = types.filter((t) => t !== "main_frame" && t !== "history");
  if (nonNavigation.length === 0) return { applyTo: "navigation", resourceTypes: [] };

  const resourceTypes = mapResourceTypes(types, warn);
  if (types.includes("history") && !types.includes("main_frame")) {
    warn("history-state redirects are covered by main_frame in Reroute");
  }
  return { applyTo: "all", resourceTypes };
}

/** Converts one Redirector redirect; returns an error message instead of an item when it cannot. */
export function convertRedirectorRedirect(
  input: unknown,
  index: number,
): RedirectorImportItem | string {
  const where = `redirect[${index}]`;
  if (!isRecord(input)) return `${where}: not an object`;
  const warnings: string[] = [];
  const warn: Warn = (message) => void warnings.push(message);

  const include = input.includePattern;
  if (typeof include !== "string" || include.length === 0) {
    return `${where}: includePattern missing`;
  }
  const redirectUrl = input.redirectUrl;
  if (typeof redirectUrl !== "string") return `${where}: redirectUrl missing`;

  const matchType = readMatchType(input.patternType);
  if (matchType === null) {
    return `${where}: unknown patternType ${JSON.stringify(input.patternType)}`;
  }
  if (matchType === "regex" && !isValidRegexSource(include)) {
    return `${where}: includePattern is not a valid regex`;
  }

  const rule = createRule({
    name: typeof input.description === "string" ? input.description : "",
    enabled: input.disabled !== true,
    matchType,
    include,
    exclude: readExclude(input.excludePattern, matchType, warn),
    redirectTo: redirectUrl,
    transforms: readTransforms(input, warn),
    ...readAppliesTo(input.appliesTo, warn),
  });
  return { rule, warnings };
}

/** Accepts the Redirector export object or a bare array of redirects. */
export function importRedirector(input: unknown): RedirectorImportResult {
  let list: unknown[];
  let source = "Redirector";
  if (Array.isArray(input)) list = input;
  else if (isRecord(input) && Array.isArray(input.redirects)) {
    list = input.redirects;
    if (typeof input.createdBy === "string") source = input.createdBy;
  } else {
    return { items: [], errors: ['Expected a Redirector export with a "redirects" array'], source };
  }
  const items: RedirectorImportItem[] = [];
  const errors: string[] = [];
  list.forEach((entry, i) => {
    const res = convertRedirectorRedirect(entry, i);
    if (typeof res === "string") errors.push(res);
    else items.push(res);
  });
  return { items, errors, source };
}

export function importRedirectorJson(text: string): RedirectorImportResult {
  try {
    return importRedirector(JSON.parse(text));
  } catch (e) {
    return { items: [], errors: [`Invalid JSON: ${errorMessage(e)}`], source: "Redirector" };
  }
}

/** Heuristic used by the UI to pick an importer automatically. */
export function looksLikeRedirectorExport(json: unknown): boolean {
  if (Array.isArray(json)) return json.some((x) => isRecord(x) && "includePattern" in x);
  return isRecord(json) && Array.isArray(json.redirects);
}

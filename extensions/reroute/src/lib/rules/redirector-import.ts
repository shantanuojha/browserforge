/**
 * Importer for Redirector's JSON export format.
 *
 * {
 *   "createdBy": "Redirector v3.5.3", "createdAt": "...",
 *   "redirects": [{
 *     "description", "exampleUrl", "exampleResult", "error",
 *     "includePattern", "excludePattern", "patternDesc", "redirectUrl",
 *     "patternType": "W" | "R",
 *     "processMatches": "noProcessing" | "urlDecode" | "urlEncode" | "base64decode" | "base64encode",
 *     "disabled": boolean, "grouped": boolean,
 *     "appliesTo": ["main_frame", "sub_frame", "stylesheet", "script", "image", "imageset",
 *                   "object", "xmlhttprequest", "history", "other"]
 *   }]
 * }
 */

import {
  createRule,
  isResourceType,
  isValidRegexSource,
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const PROCESS_MATCHES: Record<string, Transform[]> = {
  noProcessing: [],
  urlDecode: ["decodeURIComponent"],
  urlEncode: ["encodeURIComponent"],
  base64decode: ["atob"],
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

export function convertRedirectorRedirect(
  input: unknown,
  index: number,
): RedirectorImportItem | string {
  const where = `redirect[${index}]`;
  if (!isRecord(input)) return `${where}: not an object`;
  const warnings: string[] = [];

  const include = input.includePattern;
  if (typeof include !== "string" || include.length === 0)
    return `${where}: includePattern missing`;
  const redirectUrl = input.redirectUrl;
  if (typeof redirectUrl !== "string") return `${where}: redirectUrl missing`;

  const patternType = input.patternType;
  let matchType: Rule["matchType"];
  if (patternType === "W" || patternType === undefined) matchType = "wildcard";
  else if (patternType === "R") matchType = "regex";
  else return `${where}: unknown patternType ${JSON.stringify(patternType)}`;

  if (matchType === "regex" && !isValidRegexSource(include))
    return `${where}: includePattern is not a valid regex`;

  const exclude: string[] = [];
  if (typeof input.excludePattern === "string" && input.excludePattern.length > 0) {
    if (matchType === "regex" && !isValidRegexSource(input.excludePattern)) {
      warnings.push("excludePattern is not a valid regex and was dropped");
    } else {
      exclude.push(input.excludePattern);
    }
  }

  let transforms: Transform[] = [];
  if (input.processMatches !== undefined) {
    const t =
      typeof input.processMatches === "string" ? PROCESS_MATCHES[input.processMatches] : undefined;
    if (t === undefined) {
      warnings.push(
        `unknown processMatches ${JSON.stringify(input.processMatches)}; no transform applied`,
      );
    } else {
      transforms = t;
    }
  }

  let applyTo: Rule["applyTo"] = "navigation";
  const resourceTypes: ResourceType[] = [];
  if (Array.isArray(input.appliesTo) && input.appliesTo.length > 0) {
    const types = input.appliesTo.filter((x): x is string => typeof x === "string");
    const nonNavigation = types.filter((t) => t !== "main_frame" && t !== "history");
    if (nonNavigation.length > 0) {
      applyTo = "all";
      const seen = new Set<ResourceType>();
      for (const t of types) {
        const mapped = REDIRECTOR_TYPES[t];
        if (mapped === undefined) {
          if (isResourceType(t)) seen.add(t);
          else warnings.push(`unknown appliesTo type "${t}" was dropped`);
        } else if (mapped !== null) {
          seen.add(mapped);
        } else if (t === "history") {
          seen.add("main_frame");
        }
      }
      resourceTypes.push(...seen);
      if (types.includes("history") && !types.includes("main_frame"))
        warnings.push("history-state redirects are covered by main_frame in Reroute");
    }
  }

  const name = typeof input.description === "string" ? input.description : "";
  const enabled = input.disabled === true ? false : true;

  const rule = createRule({
    name,
    enabled,
    matchType,
    include,
    exclude,
    redirectTo: redirectUrl,
    transforms,
    applyTo,
    resourceTypes,
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
    return {
      items: [],
      errors: [`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`],
      source: "Redirector",
    };
  }
}

/** Heuristic used by the UI to pick an importer automatically. */
export function looksLikeRedirectorExport(json: unknown): boolean {
  if (Array.isArray(json)) return json.some((x) => isRecord(x) && "includePattern" in x);
  return isRecord(json) && Array.isArray(json.redirects);
}

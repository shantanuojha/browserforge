/**
 * Detects what a pasted import text is (share link, Redirector export, Reroute JSON) and
 * turns it into a preview the Import / Export tab can show before anything is applied.
 */

import { errorMessage } from "@browserforge/shared";
import { parseRules, type Rule } from "./model";
import { importRedirector, looksLikeRedirectorExport } from "./redirector-import";
import { decodeShareLink, isShareLink } from "./share";

export interface ImportPreview {
  source: string;
  rules: Rule[];
  warnings: string[];
  errors: string[];
}

function invalidJsonPreview(error: unknown): ImportPreview {
  return {
    source: "unknown",
    rules: [],
    warnings: [],
    errors: [`Not valid JSON: ${errorMessage(error)}`],
  };
}

function redirectorPreview(json: unknown): ImportPreview {
  const result = importRedirector(json);
  return {
    source: result.source,
    rules: result.items.map((item) => item.rule),
    warnings: result.items.flatMap((item, index) =>
      item.warnings.map((w) => `${item.rule.name || `redirect ${index + 1}`}: ${w}`),
    ),
    errors: result.errors,
  };
}

/** `null` for blank input. */
export function analyseImportText(text: string): ImportPreview | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (isShareLink(trimmed)) {
    const decoded = decodeShareLink(trimmed);
    return {
      source: "Reroute share link",
      rules: decoded.rules,
      warnings: [],
      errors: decoded.errors,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (e) {
    return invalidJsonPreview(e);
  }
  if (looksLikeRedirectorExport(json)) return redirectorPreview(json);
  const parsed = parseRules(json);
  return { source: "Reroute JSON", rules: parsed.rules, warnings: [], errors: parsed.errors };
}

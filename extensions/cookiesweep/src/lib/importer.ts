import {
  dedupeListEntries,
  isValidPattern,
  normalizePattern,
  type ListEntry,
  type ListType,
} from "./settings.js";

/**
 * Permissive importer for Cookie AutoDelete exports and CookieSweep's own export.
 *
 * Cookie AutoDelete (3.x) exports a flat JSON array of
 *   { expression: string, listType: "WHITE" | "GREY", storeId: "default" | string, cookieNames?: string[] }
 * Older releases used `domain` instead of `expression`. Some backups wrap the entries in an
 * object keyed by store id (`{ lists: { default: [...], "firefox-container-1": [...] } }`).
 *
 * Cookie AutoDelete's `*.example.com` also matched the apex domain, so it is translated to
 * our `*example.com`. `cookieNames` (per-cookie exceptions) are not supported and are
 * reported as a warning.
 */

export interface ImportSkip {
  index: number;
  reason: string;
  raw: unknown;
}

export interface ImportResult {
  entries: ListEntry[];
  skipped: ImportSkip[];
  warnings: string[];
  /** Best-effort description of what was detected. */
  format: "cookie-autodelete" | "cookiesweep" | "unknown";
}

export interface CookieSweepExport {
  app: "cookiesweep";
  version: 1;
  exportedAt: string;
  lists: ListEntry[];
}

export const EXPORT_VERSION = 1 as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseListType(value: unknown): ListType | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "white" || v === "whitelist" || v === "allow") return "white";
  if (v === "grey" || v === "gray" || v === "greylist" || v === "graylist") return "grey";
  return null;
}

/** "default" (CAD's name for the default store) means "every store" for us. */
function parseStoreId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (!v || v.toLowerCase() === "default") return undefined;
  return v;
}

/** Translate a Cookie AutoDelete expression into our pattern syntax. */
export function convertCadExpression(expression: string): string {
  const trimmed = expression.trim().toLowerCase();
  if (trimmed.startsWith("*.")) return normalizePattern(`*${trimmed.slice(2)}`);
  return normalizePattern(trimmed);
}

interface RawItem {
  index: number;
  storeId?: string;
  value: unknown;
}

/** Flatten every supported container shape into a list of candidate items. */
function collectItems(root: unknown): { items: RawItem[]; format: ImportResult["format"] } {
  if (Array.isArray(root)) {
    return {
      items: root.map((value, index) => ({ index, value })),
      format: "cookie-autodelete",
    };
  }
  if (isRecord(root)) {
    if (root.app === "cookiesweep" && Array.isArray(root.lists)) {
      return {
        items: root.lists.map((value, index) => ({ index, value })),
        format: "cookiesweep",
      };
    }
    const container =
      isRecord(root.lists) || Array.isArray(root.lists)
        ? root.lists
        : isRecord(root.expressions) || Array.isArray(root.expressions)
          ? root.expressions
          : root;
    if (Array.isArray(container)) {
      return {
        items: container.map((value, index) => ({ index, value })),
        format: "cookie-autodelete",
      };
    }
    const items: RawItem[] = [];
    let index = 0;
    for (const [storeId, list] of Object.entries(container)) {
      if (!Array.isArray(list)) continue;
      for (const value of list) {
        const store = parseStoreId(storeId);
        items.push(store ? { index: index++, storeId: store, value } : { index: index++, value });
      }
    }
    return { items, format: items.length > 0 ? "cookie-autodelete" : "unknown" };
  }
  return { items: [], format: "unknown" };
}

export function parseImport(source: string | unknown): ImportResult {
  let root: unknown = source;
  if (typeof source === "string") {
    try {
      root = JSON.parse(source);
    } catch {
      return {
        entries: [],
        skipped: [{ index: -1, reason: "Not valid JSON", raw: source }],
        warnings: [],
        format: "unknown",
      };
    }
  }

  const { items, format } = collectItems(root);
  const entries: ListEntry[] = [];
  const skipped: ImportSkip[] = [];
  let cookieNameEntries = 0;
  let unknownListTypes = 0;

  for (const item of items) {
    const raw = item.value;
    if (typeof raw === "string") {
      // Bare string lists: treat as whitelist patterns.
      const pattern = convertCadExpression(raw);
      if (!isValidPattern(pattern)) {
        skipped.push({ index: item.index, reason: "Invalid pattern", raw });
        continue;
      }
      entries.push(
        item.storeId
          ? { pattern, listType: "white", storeId: item.storeId }
          : { pattern, listType: "white" },
      );
      continue;
    }
    if (!isRecord(raw)) {
      skipped.push({ index: item.index, reason: "Not an object", raw });
      continue;
    }
    const expression = raw.expression ?? raw.domain ?? raw.pattern ?? raw.host;
    if (typeof expression !== "string" || expression.trim() === "") {
      skipped.push({ index: item.index, reason: "Missing expression/domain", raw });
      continue;
    }
    const pattern =
      format === "cookiesweep" ? normalizePattern(expression) : convertCadExpression(expression);
    if (!isValidPattern(pattern)) {
      skipped.push({ index: item.index, reason: `Invalid pattern "${expression}"`, raw });
      continue;
    }
    let listType = parseListType(raw.listType ?? raw.list ?? raw.type);
    if (!listType) {
      unknownListTypes += 1;
      listType = "white";
    }
    if (Array.isArray(raw.cookieNames) && raw.cookieNames.length > 0) cookieNameEntries += 1;

    const storeId = parseStoreId(raw.storeId ?? raw.cookieStoreId) ?? item.storeId;
    entries.push(storeId ? { pattern, listType, storeId } : { pattern, listType });
  }

  const warnings: string[] = [];
  if (cookieNameEntries > 0) {
    warnings.push(
      `${cookieNameEntries} entr${cookieNameEntries === 1 ? "y has" : "ies have"} per-cookie name exceptions (cookieNames); CookieSweep keeps whole domains, so those exceptions were ignored.`,
    );
  }
  if (unknownListTypes > 0) {
    warnings.push(
      `${unknownListTypes} entr${unknownListTypes === 1 ? "y" : "ies"} had an unknown list type and were imported as whitelist.`,
    );
  }
  const deduped = dedupeListEntries(entries);
  if (deduped.length < entries.length) {
    warnings.push(`${entries.length - deduped.length} duplicate entries were merged.`);
  }

  return { entries: deduped, skipped, warnings, format };
}

/** Merge imported entries into the existing lists (imported entries win on conflict). */
export function mergeLists(
  existing: readonly ListEntry[],
  imported: readonly ListEntry[],
): ListEntry[] {
  return dedupeListEntries([...existing, ...imported]);
}

export function buildExport(lists: readonly ListEntry[], now = new Date()): CookieSweepExport {
  return {
    app: "cookiesweep",
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    lists: dedupeListEntries(lists),
  };
}

export function serializeExport(lists: readonly ListEntry[], now = new Date()): string {
  return JSON.stringify(buildExport(lists, now), null, 2);
}

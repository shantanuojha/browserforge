import { isRecord } from "@browserforge/shared";
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

export type ImportFormat = "cookie-autodelete" | "cookiesweep" | "unknown";

export interface ImportResult {
  entries: ListEntry[];
  skipped: ImportSkip[];
  warnings: string[];
  /** Best-effort description of what was detected. */
  format: ImportFormat;
}

export interface CookieSweepExport {
  app: "cookiesweep";
  version: 1;
  exportedAt: string;
  lists: ListEntry[];
}

export const EXPORT_VERSION = 1 as const;

function parseListType(value: unknown): ListType | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "white" || v === "whitelist" || v === "allow") return "white";
  if (v === "grey" || v === "gray" || v === "greylist" || v === "graylist") return "grey";
  return null;
}

/**
 * "default" (CAD's name for the default store) means "every store" for us. CAD's `getStoreId()`
 * also rewrites Chrome's incognito store "1" to "private" before saving, so map it back;
 * Firefox's "firefox-private" is already a real store id.
 */
function parseStoreId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (!v || v.toLowerCase() === "default") return undefined;
  if (v.toLowerCase() === "private") return "1";
  return v;
}

/**
 * CAD's "Create default options" button stores per-container defaults as pseudo-expressions
 * named `_Default:WHITE` / `_Default:GREY`. They are settings, not domains.
 */
function isCadInternalExpression(expression: string): boolean {
  return /^_default:/i.test(expression.trim());
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

interface Collected {
  items: RawItem[];
  format: ImportFormat;
}

const indexed = (values: unknown[]): RawItem[] => values.map((value, index) => ({ index, value }));

/** The object or array that holds the entries inside a wrapped CAD backup. */
function containerOf(root: Record<string, unknown>): unknown {
  if (isRecord(root.lists) || Array.isArray(root.lists)) return root.lists;
  if (isRecord(root.expressions) || Array.isArray(root.expressions)) return root.expressions;
  return root;
}

/** `{ default: [...], "firefox-container-1": [...] }`: entries keyed by the store they belong to. */
function itemsByStore(container: Record<string, unknown>): RawItem[] {
  const items: RawItem[] = [];
  for (const [storeKey, list] of Object.entries(container)) {
    if (!Array.isArray(list)) continue;
    const storeId = parseStoreId(storeKey);
    for (const value of list) {
      const item: RawItem = { index: items.length, value };
      if (storeId) item.storeId = storeId;
      items.push(item);
    }
  }
  return items;
}

/** Flatten every supported container shape into a list of candidate items. */
function collectItems(root: unknown): Collected {
  if (Array.isArray(root)) return { items: indexed(root), format: "cookie-autodelete" };
  if (!isRecord(root)) return { items: [], format: "unknown" };
  if (root.app === "cookiesweep" && Array.isArray(root.lists)) {
    return { items: indexed(root.lists), format: "cookiesweep" };
  }
  const container = containerOf(root);
  if (Array.isArray(container)) return { items: indexed(container), format: "cookie-autodelete" };
  const items = itemsByStore(container as Record<string, unknown>);
  return { items, format: items.length > 0 ? "cookie-autodelete" : "unknown" };
}

/** Counters for the warnings summarised at the end of an import. */
interface ImportTally {
  cookieNameEntries: number;
  unknownListTypes: number;
}

type ItemOutcome = { entry: ListEntry } | { skip: string };

function withStore(entry: ListEntry, storeId: string | undefined): ListEntry {
  return storeId ? { ...entry, storeId } : entry;
}

/** Bare string lists: treat as whitelist patterns. */
function parseStringItem(raw: string, storeId: string | undefined): ItemOutcome {
  const pattern = convertCadExpression(raw);
  if (!isValidPattern(pattern)) return { skip: "Invalid pattern" };
  return { entry: withStore({ pattern, listType: "white" }, storeId) };
}

function parseObjectItem(
  raw: Record<string, unknown>,
  item: RawItem,
  format: ImportFormat,
  tally: ImportTally,
): ItemOutcome {
  const expression = raw.expression ?? raw.domain ?? raw.pattern ?? raw.host;
  if (typeof expression !== "string" || expression.trim() === "") {
    return { skip: "Missing expression/domain" };
  }
  if (format !== "cookiesweep" && isCadInternalExpression(expression)) {
    return { skip: "Cookie AutoDelete internal default entry" };
  }
  const pattern =
    format === "cookiesweep" ? normalizePattern(expression) : convertCadExpression(expression);
  if (!isValidPattern(pattern)) return { skip: `Invalid pattern "${expression}"` };

  let listType = parseListType(raw.listType ?? raw.list ?? raw.type);
  if (!listType) {
    tally.unknownListTypes += 1;
    listType = "white";
  }
  if (Array.isArray(raw.cookieNames) && raw.cookieNames.length > 0) tally.cookieNameEntries += 1;

  const storeId = parseStoreId(raw.storeId ?? raw.cookieStoreId) ?? item.storeId;
  return { entry: withStore({ pattern, listType }, storeId) };
}

function parseItem(item: RawItem, format: ImportFormat, tally: ImportTally): ItemOutcome {
  const raw = item.value;
  if (typeof raw === "string") return parseStringItem(raw, item.storeId);
  if (!isRecord(raw)) return { skip: "Not an object" };
  return parseObjectItem(raw, item, format, tally);
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

function tallyWarnings(tally: ImportTally, duplicates: number): string[] {
  const warnings: string[] = [];
  if (tally.cookieNameEntries > 0) {
    const n = tally.cookieNameEntries;
    warnings.push(
      `${n} entr${plural(n, "y has", "ies have")} per-cookie name exceptions (cookieNames); CookieSweep keeps whole domains, so those exceptions were ignored.`,
    );
  }
  if (tally.unknownListTypes > 0) {
    const n = tally.unknownListTypes;
    warnings.push(
      `${n} entr${plural(n, "y", "ies")} had an unknown list type and were imported as whitelist.`,
    );
  }
  if (duplicates > 0) warnings.push(`${duplicates} duplicate entries were merged.`);
  return warnings;
}

const invalidJson = (source: string): ImportResult => ({
  entries: [],
  skipped: [{ index: -1, reason: "Not valid JSON", raw: source }],
  warnings: [],
  format: "unknown",
});

export function parseImport(source: string | unknown): ImportResult {
  let root: unknown = source;
  if (typeof source === "string") {
    try {
      root = JSON.parse(source);
    } catch {
      return invalidJson(source);
    }
  }

  const { items, format } = collectItems(root);
  const entries: ListEntry[] = [];
  const skipped: ImportSkip[] = [];
  const tally: ImportTally = { cookieNameEntries: 0, unknownListTypes: 0 };

  for (const item of items) {
    const outcome = parseItem(item, format, tally);
    if ("entry" in outcome) entries.push(outcome.entry);
    else skipped.push({ index: item.index, reason: outcome.skip, raw: item.value });
  }

  const deduped = dedupeListEntries(entries);
  const warnings = tallyWarnings(tally, entries.length - deduped.length);
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

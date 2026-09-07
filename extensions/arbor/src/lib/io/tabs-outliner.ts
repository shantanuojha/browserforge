import type { NodeKind } from "../model";
import { makePreview, type ImportedNode, type ImportPreview } from "./imported";

/**
 * Permissive importer for Tabs Outliner data: the `onViewClose_lastSessionSnapshot` value from
 * its extension page localStorage, or an exported `.tree` file.
 *
 * We do not rely on a fixed schema. Anything that looks like a node (an object with `type`,
 * `data.url`, `data.title`, `url`, `title`, or a `children`/`subnodes` array) is picked up;
 * `[node, [children]]` pairs and plain arrays of nodes are both accepted; unknown wrappers are
 * descended into. Whatever cannot be recognised is counted in `warnings` and never imported
 * silently: the caller must show the preview before committing.
 */

export const TABS_OUTLINER_STORAGE_KEY = "onViewClose_lastSessionSnapshot";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

const CHILD_KEYS = ["children", "subnodes", "nodes", "items", "childs", "tabs"] as const;

function kindOf(type: string | undefined, hasUrl: boolean, hasNote: boolean): NodeKind {
  const t = (type ?? "").toLowerCase();
  if (/^(saved)?(win|window)/.test(t)) return "window";
  if (/^(saved)?tab/.test(t) || t === "page") return "tab";
  if (/note|text|comment/.test(t)) return "note";
  if (/group|folder|session|separator|root/.test(t)) return "group";
  if (hasUrl) return "tab";
  if (hasNote) return "note";
  return "group";
}

function looksLikeNode(v: unknown): v is Obj {
  if (!isObj(v)) return false;
  if (typeof v.type === "string") return true;
  if (str(v.url) || str(v.title) || str(v.note) || str(v.text)) return true;
  if (isObj(v.data) && (str(v.data.url) || str(v.data.title) || str(v.data.note))) return true;
  return CHILD_KEYS.some((k) => Array.isArray(v[k]));
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

class Parser {
  unknownObjects = 0;
  unknownValues = 0;
  depthLimitHits = 0;

  parseAny(value: unknown, depth = 0): ImportedNode[] {
    if (depth > 200) {
      this.depthLimitHits++;
      return [];
    }
    if (Array.isArray(value)) return this.parseArray(value, depth);
    if (looksLikeNode(value)) return [this.parseNode(value, depth)];
    if (isObj(value)) {
      // Unknown wrapper object: descend into its values looking for nodes.
      const found: ImportedNode[] = [];
      for (const v of Object.values(value)) {
        if (Array.isArray(v) || isObj(v)) found.push(...this.parseAny(v, depth + 1));
      }
      if (!found.length) this.unknownObjects++;
      return found;
    }
    if (
      value !== null &&
      value !== undefined &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      this.unknownValues++;
    }
    return [];
  }

  private parseArray(arr: unknown[], depth: number): ImportedNode[] {
    // `[nodeSpec, [children...]]` pair form used by Tabs Outliner's tree files.
    if (
      arr.length >= 1 &&
      arr.length <= 3 &&
      looksLikeNode(arr[0]) &&
      arr.slice(1).every(Array.isArray)
    ) {
      const node = this.parseNode(arr[0], depth);
      for (const kids of arr.slice(1)) node.children.push(...this.parseAny(kids, depth + 1));
      return [node];
    }
    const out: ImportedNode[] = [];
    for (const item of arr) out.push(...this.parseAny(item, depth + 1));
    return out;
  }

  private parseNode(o: Obj, depth: number): ImportedNode {
    const data = isObj(o.data) ? o.data : {};
    const marks = isObj(o.marks) ? o.marks : {};
    const url = str(data.url) ?? str(o.url) ?? str(data.pendingUrl);
    const noteText = str(data.note) ?? str(o.note) ?? str(data.text) ?? str(o.text);
    const customTitle = str(marks.customTitle) ?? str(o.customTitle);
    const kind = kindOf(str(o.type), url !== undefined, noteText !== undefined);
    let title = customTitle ?? str(data.title) ?? str(o.title) ?? "";
    if (!title && kind === "note") title = noteText ?? "";
    if (!title)
      title =
        kind === "window" ? "Window" : (hostOf(url) ?? (kind === "group" ? "Group" : "Untitled"));
    const favIconUrl = str(data.favIconUrl) ?? str(o.favIconUrl);
    const collapsed = o.colapsed === true || o.collapsed === true || data.collapsed === true;
    const node: ImportedNode = {
      kind,
      title: title.slice(0, 500),
      children: [],
    };
    if (kind === "tab" && url) node.url = url;
    if (favIconUrl && favIconUrl.startsWith("http")) node.favIconUrl = favIconUrl;
    if (collapsed) node.collapsed = true;
    // A note node's text is its title; on other nodes the text becomes the attached note.
    if (noteText && noteText !== title) node.note = noteText;
    for (const key of CHILD_KEYS) {
      const kids = o[key] ?? data[key];
      if (Array.isArray(kids)) node.children.push(...this.parseAny(kids, depth + 1));
    }
    return node;
  }
}

/** Accepts the raw string from localStorage (possibly double-encoded), a parsed value, or a file. */
export function decodeInput(input: string | unknown): unknown {
  let value: unknown = input;
  for (let i = 0; i < 3 && typeof value === "string"; i++) {
    const text = value.trim();
    if (!text) throw new Error("The input is empty");
    try {
      value = JSON.parse(text);
    } catch {
      if (i === 0) throw new Error("The input is not valid JSON");
      break;
    }
  }
  if (isObj(value) && TABS_OUTLINER_STORAGE_KEY in value) {
    value = decodeInput(value[TABS_OUTLINER_STORAGE_KEY]);
  }
  return value;
}

export function parseTabsOutliner(input: string | unknown): ImportPreview {
  const value = decodeInput(input);
  const parser = new Parser();
  let roots = parser.parseAny(value);
  // Tabs Outliner wraps everything in a single session/root node; unwrap it when it is untitled.
  if (
    roots.length === 1 &&
    roots[0]?.kind === "group" &&
    roots[0].children.length &&
    /^(group|session|root)$/i.test(roots[0].title)
  ) {
    roots = roots[0].children;
  }
  const warnings: string[] = [];
  if (!roots.length) warnings.push("No tabs, windows or notes were recognised in this data");
  if (parser.unknownObjects)
    warnings.push(
      `${parser.unknownObjects} object(s) were not recognised as nodes and were skipped`,
    );
  if (parser.unknownValues) warnings.push(`${parser.unknownValues} stray value(s) were ignored`);
  if (parser.depthLimitHits) warnings.push("Some nodes were nested too deeply and were skipped");
  return makePreview("Tabs Outliner", roots, warnings);
}

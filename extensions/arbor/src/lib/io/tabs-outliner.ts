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

/**
 * What the source node was. Windows and groups both become containers (`kind: "window"`); the
 * distinction only decides the default title (a window stays untitled, a group reads "Group").
 */
type Role = "window" | "group" | "tab" | "note";

function roleOf(type: string | undefined, hasUrl: boolean, hasNote: boolean): Role {
  const t = (type ?? "").toLowerCase();
  if (/^(saved)?(win|window)/.test(t)) return "window";
  if (/^(saved)?tab/.test(t) || t === "page") return "tab";
  if (/note|text|comment/.test(t)) return "note";
  if (/group|folder|session|separator|root/.test(t)) return "group";
  if (hasUrl) return "tab";
  if (hasNote) return "note";
  return "group";
}

const kindOf = (role: Role): NodeKind => (role === "group" ? "window" : role);

function looksLikeNode(v: unknown): v is Obj {
  if (!isObj(v)) return false;
  if (typeof v.type === "string") return true;
  if (str(v.url) || str(v.title) || str(v.note) || str(v.text)) return true;
  if (isObj(v.data) && (str(v.data.url) || str(v.data.title) || str(v.data.note))) return true;
  return CHILD_KEYS.some((k) => Array.isArray(v[k]));
}

/** `[flag, nodeSpec, indexPath]`: one node of the flat row form, position given by the path. */
function isPathRow(v: unknown): v is [unknown, Obj, number[]] {
  return (
    Array.isArray(v) &&
    v.length >= 3 &&
    looksLikeNode(v[1]) &&
    Array.isArray(v[2]) &&
    v[2].every((i) => typeof i === "number")
  );
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

/** What a Tabs Outliner node record says about itself, wherever it keeps it. */
interface SourceFields {
  type: string | undefined;
  url: string | undefined;
  noteText: string | undefined;
  customTitle: string | undefined;
  title: string | undefined;
  favIconUrl: string | undefined;
  collapsed: boolean;
}

/** The first non-empty string among the candidates. */
const firstStr = (...values: unknown[]): string | undefined => values.map(str).find(Boolean);

function sourceFields(o: Obj): SourceFields {
  const data = isObj(o.data) ? o.data : {};
  const marks = isObj(o.marks) ? o.marks : {};
  return {
    type: str(o.type),
    url: firstStr(data.url, o.url, data.pendingUrl),
    noteText: firstStr(data.note, o.note, data.text, o.text),
    customTitle: firstStr(marks.customTitle, o.customTitle),
    title: firstStr(data.title, o.title),
    favIconUrl: firstStr(data.favIconUrl, o.favIconUrl),
    // Tabs Outliner spells it "colapsed"; accept both, on the node or in its data bag.
    collapsed: [o.colapsed, o.collapsed, data.collapsed].includes(true),
  };
}

/**
 * The imported title: the user's custom title, else the source title, else the note's text for
 * a note. An unnamed window stays untitled (Arbor shows "Window"); an unnamed group reads
 * "Group"; an unnamed tab reads as its host.
 */
function titleFor(fields: SourceFields, role: Role): string {
  const given = fields.customTitle ?? fields.title ?? "";
  if (given) return given;
  if (role === "note" && fields.noteText) return fields.noteText;
  if (role === "window") return "";
  return role === "group" ? "Group" : (hostOf(fields.url) ?? "Untitled");
}

/** Values that carry no nodes and are not obviously noise (numbers, booleans, null). */
const isStrayValue = (value: unknown): boolean =>
  value !== null && value !== undefined && typeof value !== "number" && typeof value !== "boolean";

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
    if (isObj(value)) return this.parseWrapper(value, depth);
    if (isStrayValue(value)) this.unknownValues++;
    return [];
  }

  /** Unknown wrapper object: descend into its values looking for nodes. */
  private parseWrapper(value: Obj, depth: number): ImportedNode[] {
    const found: ImportedNode[] = [];
    for (const v of Object.values(value)) {
      if (Array.isArray(v) || isObj(v)) found.push(...this.parseAny(v, depth + 1));
    }
    if (!found.length) this.unknownObjects++;
    return found;
  }

  private parseArray(arr: unknown[], depth: number): ImportedNode[] {
    // Flat row form: `[flag, nodeSpec, indexPath]` per node, in depth-first order, with the
    // position in the tree encoded in the index path (what the session snapshot, the IndexedDB
    // dump and exported .tree files hold). Without this the rows would parse as a flat list and
    // every tab would end up beside its window instead of under it.
    if (arr.some(isPathRow)) return this.parsePathRows(arr, depth);
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

  /**
   * Attach each `[flag, nodeSpec, indexPath]` row under the row whose path is its prefix. A row
   * whose parent path was never seen (or a root row at `[]`) becomes a root itself; a row at
   * `[]` that has children is the session wrapper `parseTabsOutliner` unwraps. Elements that are
   * not path rows are parsed as usual so nothing recognisable is skipped.
   */
  private parsePathRows(arr: unknown[], depth: number): ImportedNode[] {
    const roots: ImportedNode[] = [];
    const byPath = new Map<string, ImportedNode>();
    for (const item of arr) {
      if (!isPathRow(item)) {
        roots.push(...this.parseAny(item, depth + 1));
        continue;
      }
      const path = item[2];
      const node = this.parseNode(item[1], depth);
      const parent = path.length ? byPath.get(JSON.stringify(path.slice(0, -1))) : undefined;
      (parent ? parent.children : roots).push(node);
      byPath.set(JSON.stringify(path), node);
    }
    return roots;
  }

  private parseNode(o: Obj, depth: number): ImportedNode {
    const fields = sourceFields(o);
    const role = roleOf(fields.type, fields.url !== undefined, fields.noteText !== undefined);
    const kind = kindOf(role);
    const title = titleFor(fields, role);
    const node: ImportedNode = { kind, title: title.slice(0, 500), children: [] };
    if (kind === "tab" && fields.url) node.url = fields.url;
    if (fields.favIconUrl?.startsWith("http")) node.favIconUrl = fields.favIconUrl;
    if (fields.collapsed) node.collapsed = true;
    // A note node's text is its title; on other nodes the text becomes the attached note.
    if (fields.noteText && fields.noteText !== title) node.note = fields.noteText;
    node.children.push(...this.parseChildren(o, depth));
    return node;
  }

  /** Children under any of the keys Tabs Outliner has used, on the node or its `data` bag. */
  private parseChildren(o: Obj, depth: number): ImportedNode[] {
    const data = isObj(o.data) ? o.data : {};
    const out: ImportedNode[] = [];
    for (const key of CHILD_KEYS) {
      const kids = o[key] ?? data[key];
      if (Array.isArray(kids)) out.push(...this.parseAny(kids, depth + 1));
    }
    return out;
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
    roots[0]?.kind === "window" &&
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

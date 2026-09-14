import {
  buildChildIndex,
  coerceNode,
  createTree,
  DEFAULT_WINDOW_TITLE,
  serializeNodes,
  type ChildIndex,
  type Tree,
  type TreeNode,
} from "../model";
import { fileStamp } from "../format";
import { makePreview, type ImportedNode, type ImportPreview } from "./imported";

export const ARBOR_FORMAT = "arbor-tree" as const;
/**
 * Schema versions of the export file:
 * - 1 (0.1.0 to 0.1.3): node kinds `window | tab | group | note`; windows opened by the browser
 *   were titled "Window".
 * - 2 (0.1.4+): one container kind, `window`, bound or not; a group is an unbound container with
 *   a title; browser-made windows carry an empty title. Version 1 files are still read: `group`
 *   becomes `window` (see `coerceNode`), so old exports and backups import unchanged.
 */
export const ARBOR_FORMAT_VERSION = 2 as const;

export interface ArborExport {
  format: typeof ARBOR_FORMAT;
  version: typeof ARBOR_FORMAT_VERSION;
  exportedAt: number;
  nodeCount: number;
  nodes: TreeNode[];
}

/** Snapshot of the tree in our own JSON format. Live ids are stripped: an export is always "saved". */
export function createExport(tree: Tree, now: number): ArborExport {
  const nodes = serializeNodes(tree).map((n) => {
    const copy: TreeNode = { ...n };
    delete copy.liveTabId;
    delete copy.liveWindowId;
    return copy;
  });
  return {
    format: ARBOR_FORMAT,
    version: ARBOR_FORMAT_VERSION,
    exportedAt: now,
    nodeCount: nodes.length,
    nodes,
  };
}

export function isArborExport(value: unknown): value is { nodes: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).format === ARBOR_FORMAT &&
    Array.isArray((value as Record<string, unknown>).nodes)
  );
}

/** Nodes that parsed, with the pre-0.1.4 default window title normalised; `skipped` counts the rest. */
function readNodes(raw: readonly unknown[], now: number): { nodes: TreeNode[]; skipped: number } {
  const nodes: TreeNode[] = [];
  let skipped = 0;
  for (const value of raw) {
    const n = coerceNode(value, now);
    if (!n) {
      skipped++;
      continue;
    }
    // Version 1 titled browser-made windows "Window"; that is the empty title now.
    nodes.push(n.kind === "window" && n.title === DEFAULT_WINDOW_TITLE ? { ...n, title: "" } : n);
  }
  return { nodes, skipped };
}

/** A second node with an id already seen would silently replace the first in the tree map. */
function dropDuplicateIds(nodes: readonly TreeNode[]): { unique: TreeNode[]; duplicates: number } {
  const ids = new Set<string>();
  const unique: TreeNode[] = [];
  let duplicates = 0;
  for (const n of nodes) {
    if (ids.has(n.id)) {
      duplicates++;
      continue;
    }
    ids.add(n.id);
    unique.push(n);
  }
  return { unique, duplicates };
}

/** Nodes whose parent is not in the file are lifted to the root instead of being dropped. */
function liftOrphans(nodes: readonly TreeNode[]): { fixed: TreeNode[]; lifted: number } {
  const ids = new Set(nodes.map((n) => n.id));
  let lifted = 0;
  const fixed = nodes.map((n) => {
    if (n.parentId === null || ids.has(n.parentId)) return n;
    lifted++;
    return { ...n, parentId: null };
  });
  return { fixed, lifted };
}

/**
 * Nodes whose parent chain loops never hang off the root and would be dropped by the export
 * walk. Lift one node of each such cycle to the top level; the rest follow under it. Mutates
 * `index` so the following walk sees the lifted roots. Returns how many were lifted.
 */
function liftCycles(fixed: readonly TreeNode[], index: ChildIndex): number {
  const reachable = new Set<string>();
  const reach = (from: readonly TreeNode[]): void => {
    const stack = [...from];
    while (stack.length) {
      const n = stack.pop() as TreeNode;
      if (reachable.has(n.id)) continue;
      reachable.add(n.id);
      stack.push(...(index.get(n.id) ?? []));
    }
  };
  reach(index.get(null) ?? []);
  let lifted = 0;
  for (const n of fixed) {
    if (reachable.has(n.id)) continue;
    lifted++;
    const root = { ...n, parentId: null };
    const roots = index.get(null);
    if (roots) roots.push(root);
    else index.set(null, [root]);
    reach([n]);
  }
  return lifted;
}

function toImportedRoots(index: ChildIndex): ImportedNode[] {
  const seen = new Set<string>();
  const toImported = (n: TreeNode): ImportedNode => {
    seen.add(n.id);
    return {
      kind: n.kind,
      title: n.title,
      url: n.url,
      favIconUrl: n.favIconUrl,
      note: n.note,
      collapsed: n.collapsed,
      children: (index.get(n.id) ?? []).filter((c) => !seen.has(c.id)).map(toImported),
    };
  };
  return (index.get(null) ?? []).map(toImported);
}

function repairWarnings(counts: { skipped: number; duplicates: number; lifted: number }): string[] {
  const warnings: string[] = [];
  if (counts.skipped) warnings.push(`${counts.skipped} unreadable node(s) were skipped`);
  if (counts.duplicates) {
    warnings.push(`${counts.duplicates} node(s) with a duplicate id were skipped`);
  }
  if (counts.lifted) {
    warnings.push(`${counts.lifted} node(s) had a missing parent and were moved to the top level`);
  }
  return warnings;
}

/**
 * Parse our own export (any schema version) into an importable tree. Nodes whose parent is
 * missing are lifted to the root instead of being dropped; the number of such repairs is
 * reported in `warnings`. `now` stands in for timestamps a damaged file lacks.
 */
export function parseArborExport(input: string | unknown, now: number): ImportPreview {
  const value: unknown = typeof input === "string" ? JSON.parse(input) : input;
  if (!isArborExport(value)) throw new Error("Not an Arbor export (missing format/nodes)");
  const { nodes, skipped } = readNodes(value.nodes, now);
  const { unique, duplicates } = dropDuplicateIds(nodes);
  const { fixed, lifted } = liftOrphans(unique);
  const index = buildChildIndex(createTree(fixed));
  const liftedCycles = liftCycles(fixed, index);
  const warnings = repairWarnings({ skipped, duplicates, lifted: lifted + liftedCycles });
  return makePreview("Arbor export", toImportedRoots(index), warnings);
}

export function exportFileName(now: Date): string {
  return `arbor-${fileStamp(now)}.json`;
}

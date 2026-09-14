import {
  buildChildIndex,
  coerceNode,
  createTree,
  DEFAULT_WINDOW_TITLE,
  serializeNodes,
  type Tree,
  type TreeNode,
} from "../model";
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
export function createExport(tree: Tree, now = Date.now()): ArborExport {
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

/**
 * Parse our own export (any schema version) into an importable tree. Nodes whose parent is
 * missing are lifted to the root instead of being dropped; the number of such repairs is
 * reported in `warnings`.
 */
export function parseArborExport(input: string | unknown): ImportPreview {
  let value: unknown = input;
  if (typeof input === "string") value = JSON.parse(input);
  if (!isArborExport(value)) throw new Error("Not an Arbor export (missing format/nodes)");
  const nodes: TreeNode[] = [];
  let skipped = 0;
  for (const raw of value.nodes) {
    const n = coerceNode(raw);
    if (!n) {
      skipped++;
      continue;
    }
    // Version 1 titled browser-made windows "Window"; that is the empty title now.
    nodes.push(n.kind === "window" && n.title === DEFAULT_WINDOW_TITLE ? { ...n, title: "" } : n);
  }
  // A second node with an id already seen would silently replace the first in the tree map.
  const ids = new Set<string>();
  let duplicates = 0;
  const unique: TreeNode[] = [];
  for (const n of nodes) {
    if (ids.has(n.id)) {
      duplicates++;
      continue;
    }
    ids.add(n.id);
    unique.push(n);
  }
  let lifted = 0;
  const fixed = unique.map((n) => {
    if (n.parentId !== null && !ids.has(n.parentId)) {
      lifted++;
      return { ...n, parentId: null };
    }
    return n;
  });
  // Nodes whose parent chain loops never hang off the root and would be dropped by the walk
  // below. Lift one node of each such cycle to the top level; the rest follow under it.
  const index = buildChildIndex(createTree(fixed));
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
  for (const n of fixed) {
    if (reachable.has(n.id)) continue;
    lifted++;
    const root = { ...n, parentId: null };
    const roots = index.get(null);
    if (roots) roots.push(root);
    else index.set(null, [root]);
    reach([n]);
  }
  const warnings: string[] = [];
  if (skipped) warnings.push(`${skipped} unreadable node(s) were skipped`);
  if (duplicates) warnings.push(`${duplicates} node(s) with a duplicate id were skipped`);
  if (lifted)
    warnings.push(`${lifted} node(s) had a missing parent and were moved to the top level`);
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
  const roots = (index.get(null) ?? []).map(toImported);
  return makePreview("Arbor export", roots, warnings);
}

export function exportFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `arbor-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`;
}

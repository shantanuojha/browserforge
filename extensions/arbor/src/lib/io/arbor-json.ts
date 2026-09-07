import {
  buildChildIndex,
  coerceNode,
  createTree,
  serializeNodes,
  type Tree,
  type TreeNode,
} from "../model";
import { makePreview, type ImportedNode, type ImportPreview } from "./imported";

export const ARBOR_FORMAT = "arbor-tree" as const;
export const ARBOR_FORMAT_VERSION = 1 as const;

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
 * Parse our own export into an importable tree. Nodes whose parent is missing are lifted to the
 * root instead of being dropped; the number of such repairs is reported in `warnings`.
 */
export function parseArborExport(input: string | unknown): ImportPreview {
  let value: unknown = input;
  if (typeof input === "string") value = JSON.parse(input);
  if (!isArborExport(value)) throw new Error("Not an Arbor export (missing format/nodes)");
  const nodes: TreeNode[] = [];
  let skipped = 0;
  for (const raw of value.nodes) {
    const n = coerceNode(raw);
    if (n) nodes.push(n);
    else skipped++;
  }
  const ids = new Set(nodes.map((n) => n.id));
  let lifted = 0;
  const fixed = nodes.map((n) => {
    if (n.parentId !== null && !ids.has(n.parentId)) {
      lifted++;
      return { ...n, parentId: null };
    }
    return n;
  });
  const warnings: string[] = [];
  if (skipped) warnings.push(`${skipped} unreadable node(s) were skipped`);
  if (lifted)
    warnings.push(`${lifted} node(s) had a missing parent and were moved to the top level`);

  const tree = createTree(fixed);
  const index = buildChildIndex(tree);
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

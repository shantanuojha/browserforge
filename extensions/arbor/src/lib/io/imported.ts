import type { Clock } from "@browserforge/shared";
import { makeNode, type NodeKind, type TreeNode } from "../model";

/**
 * Browser-agnostic intermediate tree produced by every importer before it touches the store.
 * Windows and groups of the source both become containers (`kind: "window"`, imported closed);
 * an empty title marks a container the source did not name (shown as "Window").
 */
export interface ImportedNode {
  kind: NodeKind;
  title: string;
  url?: string | undefined;
  favIconUrl?: string | undefined;
  note?: string | undefined;
  collapsed?: boolean | undefined;
  children: ImportedNode[];
}

export interface ImportCounts {
  /** Containers: the source's windows and groups alike. */
  windows: number;
  tabs: number;
  notes: number;
  total: number;
}

export interface ImportPreview {
  source: string;
  roots: ImportedNode[];
  counts: ImportCounts;
  /** First few titles, so the user can sanity-check before committing. */
  sample: string[];
  warnings: string[];
}

export function countImported(roots: readonly ImportedNode[]): ImportCounts {
  const counts: ImportCounts = { windows: 0, tabs: 0, notes: 0, total: 0 };
  const walk = (n: ImportedNode): void => {
    counts.total++;
    if (n.kind === "window") counts.windows++;
    else if (n.kind === "tab") counts.tabs++;
    else counts.notes++;
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return counts;
}

export function sampleTitles(roots: readonly ImportedNode[], limit = 8): string[] {
  const out: string[] = [];
  const walk = (n: ImportedNode): void => {
    if (out.length >= limit) return;
    if (n.kind === "tab" || n.kind === "note") out.push(n.title);
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

export function makePreview(
  source: string,
  roots: ImportedNode[],
  warnings: string[] = [],
): ImportPreview {
  return { source, roots, counts: countImported(roots), sample: sampleTitles(roots), warnings };
}

export interface MaterializeOptions {
  /**
   * Title of the container (a closed, named one: a group) the import is wrapped in. Pass null
   * to import at the root.
   */
  wrapTitle?: string | null | undefined;
  newId: () => string;
  now: Clock;
}

/**
 * Turn an imported tree into flat `TreeNode`s with fresh ids and no live references, ready to be
 * added to the store with `add` ops (parents always precede children).
 */
export function materialize(
  roots: readonly ImportedNode[],
  options: MaterializeOptions,
): TreeNode[] {
  const { newId, now } = options;
  const ts = now();
  const out: TreeNode[] = [];
  let parentId: string | null = null;
  if (options.wrapTitle !== null) {
    const wrapper = makeNode({
      id: newId(),
      parentId: null,
      kind: "window",
      title: options.wrapTitle ?? `Imported ${new Date(ts).toLocaleString()}`,
      ts,
    });
    out.push(wrapper);
    parentId = wrapper.id;
  }
  const walk = (n: ImportedNode, parent: string | null, order: number): void => {
    const node = makeNode({
      id: newId(),
      parentId: parent,
      kind: n.kind,
      title: n.title,
      url: n.url,
      favIconUrl: n.favIconUrl,
      note: n.note,
      collapsed: n.collapsed,
      ts,
    });
    node.order = order;
    out.push(node);
    n.children.forEach((c, i) => walk(c, node.id, i));
  };
  roots.forEach((r, i) => walk(r, parentId, i));
  return out;
}

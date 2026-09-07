import { newId as defaultNewId } from "../ids";
import { makeNode, type NodeKind, type TreeNode } from "../model";

/** Browser-agnostic intermediate tree produced by every importer before it touches the store. */
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
  windows: number;
  tabs: number;
  groups: number;
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
  const counts: ImportCounts = { windows: 0, tabs: 0, groups: 0, notes: 0, total: 0 };
  const walk = (n: ImportedNode): void => {
    counts.total++;
    if (n.kind === "window") counts.windows++;
    else if (n.kind === "tab") counts.tabs++;
    else if (n.kind === "group") counts.groups++;
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
  /** Title of the group node the import is wrapped in. Pass null to import at the root. */
  wrapTitle?: string | null | undefined;
  newId?: (() => string) | undefined;
  now?: (() => number) | undefined;
}

/**
 * Turn an imported tree into flat `TreeNode`s with fresh ids and no live references, ready to be
 * added to the store with `add` ops (parents always precede children).
 */
export function materialize(
  roots: readonly ImportedNode[],
  options: MaterializeOptions = {},
): TreeNode[] {
  const newId = options.newId ?? defaultNewId;
  const now = options.now ?? (() => Date.now());
  const ts = now();
  const out: TreeNode[] = [];
  let parentId: string | null = null;
  if (options.wrapTitle !== null) {
    const wrapper = makeNode({
      id: newId(),
      parentId: null,
      kind: "group",
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

/** The tree as the panel renders it: one row per visible node, depth-first. */
import { ancestorsOf, buildChildIndex } from "./queries";
import type { NodeId, Tree, TreeNode } from "./types";

export interface FlatRow {
  node: TreeNode;
  depth: number;
  hasChildren: boolean;
  /** Set when a search is active and this node matched (ancestors of matches are not "matches"). */
  matched: boolean;
}

interface Visibility {
  /** Nodes to show: the matches and every ancestor of a match. */
  visible: Set<NodeId>;
  matches: Set<NodeId>;
}

/** With a search active, matching nodes and all their ancestors are shown, expanded. */
function visibilityFor(tree: Tree, filter: (n: TreeNode) => boolean): Visibility {
  const visible = new Set<NodeId>();
  const matches = new Set<NodeId>();
  for (const n of tree.values()) {
    if (!filter(n)) continue;
    matches.add(n.id);
    visible.add(n.id);
    for (const a of ancestorsOf(tree, n.id)) visible.add(a.id);
  }
  return { visible, matches };
}

/**
 * Flatten the tree for rendering. Collapsed nodes hide their children unless a `filter` is
 * active, in which case matching nodes and all their ancestors are shown expanded.
 */
export function flattenTree(tree: Tree, filter?: (n: TreeNode) => boolean): FlatRow[] {
  const rows: FlatRow[] = [];
  const search = filter ? visibilityFor(tree, filter) : null;
  const index = buildChildIndex(tree);
  const seen = new Set<NodeId>();
  const walk = (parentId: NodeId | null, depth: number): void => {
    for (const n of index.get(parentId) ?? []) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      if (search && !search.visible.has(n.id)) continue;
      const kids = index.get(n.id) ?? [];
      rows.push({
        node: n,
        depth,
        hasChildren: kids.length > 0,
        matched: search ? search.matches.has(n.id) : false,
      });
      if (search || !n.collapsed) walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

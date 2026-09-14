/** Read-only questions about a tree: children, ancestry, live bindings, serialisation, validity. */
import { DEFAULT_WINDOW_TITLE, type NodeId, type Tree, type TreeNode } from "./types";

export function createTree(nodes: Iterable<TreeNode> = []): Tree {
  const map = new Map<NodeId, TreeNode>();
  for (const n of nodes) map.set(n.id, n);
  return map;
}

function compareIds(a: NodeId, b: NodeId): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function compareSiblings(a: TreeNode, b: TreeNode): number {
  if (a.order !== b.order) return a.order - b.order;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return compareIds(a.id, b.id);
}

export function childrenOf(tree: Tree, parentId: NodeId | null): TreeNode[] {
  const out: TreeNode[] = [];
  for (const n of tree.values()) if (n.parentId === parentId) out.push(n);
  out.sort(compareSiblings);
  return out;
}

export function rootsOf(tree: Tree): TreeNode[] {
  return childrenOf(tree, null);
}

export type ChildIndex = Map<NodeId | null, TreeNode[]>;

/** One pass over the tree producing sorted children lists keyed by parent id. */
export function buildChildIndex(tree: Tree): ChildIndex {
  const index: ChildIndex = new Map();
  for (const n of tree.values()) {
    const list = index.get(n.parentId);
    if (list) list.push(n);
    else index.set(n.parentId, [n]);
  }
  for (const list of index.values()) list.sort(compareSiblings);
  return index;
}

/** Depth-first list of descendant ids (not including `id`). */
export function descendantIds(tree: Tree, id: NodeId, index?: ChildIndex): NodeId[] {
  const idx = index ?? buildChildIndex(tree);
  const out: NodeId[] = [];
  const stack = [...(idx.get(id) ?? [])].reverse();
  const seen = new Set<NodeId>();
  while (stack.length) {
    const n = stack.pop();
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n.id);
    const kids = idx.get(n.id) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as TreeNode);
  }
  return out;
}

/** True when `ancestorId` is `id` itself or one of its ancestors. */
export function isSelfOrAncestor(tree: Tree, ancestorId: NodeId, id: NodeId): boolean {
  let cur: TreeNode | undefined = tree.get(id);
  const seen = new Set<NodeId>();
  while (cur) {
    if (cur.id === ancestorId) return true;
    if (seen.has(cur.id)) return false; // defensive against corrupt cycles
    seen.add(cur.id);
    cur = cur.parentId === null ? undefined : tree.get(cur.parentId);
  }
  return false;
}

export function ancestorsOf(tree: Tree, id: NodeId): TreeNode[] {
  const out: TreeNode[] = [];
  let cur = tree.get(id);
  const seen = new Set<NodeId>();
  while (cur && cur.parentId !== null && !seen.has(cur.id)) {
    seen.add(cur.id);
    const p = tree.get(cur.parentId);
    if (!p) break;
    out.push(p);
    cur = p;
  }
  return out;
}

/** A container: the one node kind that holds tabs and can be opened as a browser window. */
export function isContainer(node: TreeNode): boolean {
  return node.kind === "window";
}

/** A container that mirrors an open browser window right now. */
export function isBound(node: TreeNode): boolean {
  return node.kind === "window" && node.liveWindowId !== undefined;
}

/** A tab node that mirrors an open browser tab right now. */
export function isLiveTab(node: TreeNode): boolean {
  return node.kind === "tab" && node.liveTabId !== undefined;
}

/**
 * Title to show for a node. Containers the browser created carry an empty title and read as
 * "Window"; a tab without a title falls back to its url.
 */
export function displayTitle(node: Pick<TreeNode, "kind" | "title" | "url">): string {
  if (node.title) return node.title;
  if (node.kind === "window") return DEFAULT_WINDOW_TITLE;
  return node.url || "Untitled";
}

/** Nearest ancestor (or self) that is a container (`kind: "window"`, bound or not). */
export function windowNodeOf(tree: Tree, id: NodeId): TreeNode | undefined {
  let cur = tree.get(id);
  const seen = new Set<NodeId>();
  while (cur && !seen.has(cur.id)) {
    if (cur.kind === "window") return cur;
    seen.add(cur.id);
    cur = cur.parentId === null ? undefined : tree.get(cur.parentId);
  }
  return undefined;
}

export function findByLiveTabId(tree: Tree, tabId: number): TreeNode | undefined {
  for (const n of tree.values()) if (n.kind === "tab" && n.liveTabId === tabId) return n;
  return undefined;
}

export function findWindowByLiveId(tree: Tree, windowId: number): TreeNode | undefined {
  for (const n of tree.values()) if (n.kind === "window" && n.liveWindowId === windowId) return n;
  return undefined;
}

/**
 * Tab nodes a container's "Reopen all" / "Close all and save" act on: every tab in its subtree
 * except those inside a nested container, which is a window (open or closed) of its own and is
 * only acted on when the user picks it. Depth-first, tree order.
 */
export function containerTabs(tree: Tree, containerId: NodeId, index?: ChildIndex): TreeNode[] {
  const idx = index ?? buildChildIndex(tree);
  const out: TreeNode[] = [];
  const seen = new Set<NodeId>();
  const walk = (parentId: NodeId): void => {
    for (const n of idx.get(parentId) ?? []) {
      if (seen.has(n.id) || n.kind === "window") continue;
      seen.add(n.id);
      if (n.kind === "tab") out.push(n);
      walk(n.id);
    }
  };
  walk(containerId);
  return out;
}

export function nodeCount(tree: Tree): number {
  return tree.size;
}

/** Nodes in deterministic depth-first order, suitable for snapshots and export. */
export function serializeNodes(tree: Tree): TreeNode[] {
  const out: TreeNode[] = [];
  const index = buildChildIndex(tree);
  const seen = new Set<NodeId>();
  const walk = (parentId: NodeId | null): void => {
    for (const n of index.get(parentId) ?? []) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n);
      walk(n.id);
    }
  };
  walk(null);
  // Orphans (should not exist, but never drop data on export).
  if (out.length !== tree.size) {
    for (const n of tree.values()) if (!seen.has(n.id)) out.push(n);
  }
  return out;
}

/** Parents that do not exist and nodes that are their own parent. */
function linkProblems(tree: Tree): string[] {
  const problems: string[] = [];
  for (const n of tree.values()) {
    if (n.parentId !== null && !tree.has(n.parentId)) {
      problems.push(`node ${n.id} references missing parent ${n.parentId}`);
    }
    if (n.parentId === n.id) problems.push(`node ${n.id} is its own parent`);
  }
  return problems;
}

/** Parent chains that loop. Each node is walked once (1 = on the current path, 2 = done). */
function cycleProblems(tree: Tree): string[] {
  const problems: string[] = [];
  const state = new Map<NodeId, 1 | 2>();
  for (const start of tree.keys()) {
    let cur: NodeId | null = start;
    const path: NodeId[] = [];
    while (cur !== null && !state.has(cur)) {
      state.set(cur, 1);
      path.push(cur);
      cur = tree.get(cur)?.parentId ?? null;
    }
    if (cur !== null && state.get(cur) === 1) problems.push(`cycle through node ${cur}`);
    for (const id of path) state.set(id, 2);
  }
  return problems;
}

/** Structural validation. Returns a list of problems (empty when the tree is consistent). */
export function validateTree(tree: Tree): string[] {
  return [...linkProblems(tree), ...cycleProblems(tree)];
}

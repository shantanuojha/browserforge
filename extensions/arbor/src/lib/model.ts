/**
 * Arbor tree model: node/op/snapshot types plus pure tree operations.
 *
 * The tree is an immutable `ReadonlyMap<NodeId, TreeNode>`. Every mutation goes through an `Op`
 * so the persistence layer can log and replay it deterministically. Sibling order is an integer
 * `order` that is renumbered whenever a node is inserted, moved or removed, which keeps replay
 * simple and independent of floating-point tricks.
 */

export type NodeId = string;

export type NodeKind = "window" | "tab" | "group" | "note";

export interface TreeNode {
  id: NodeId;
  parentId: NodeId | null;
  kind: NodeKind;
  title: string;
  url?: string | undefined;
  favIconUrl?: string | undefined;
  note?: string | undefined;
  collapsed?: boolean | undefined;
  /** Set while the node mirrors an open browser tab. */
  liveTabId?: number | undefined;
  /** Set while the node mirrors an open browser window (or the window a live tab belongs to). */
  liveWindowId?: number | undefined;
  createdAt: number;
  updatedAt: number;
  order: number;
}

/**
 * Fields a caller may change on an existing node. `undefined` or `null` removes the field. Use
 * `null` for patches that travel over `runtime.sendMessage`: messaging has JSON semantics and
 * silently drops `undefined` properties, which would turn "clear this field" into a no-op.
 */
export type NodePatch = {
  [K in keyof Omit<TreeNode, "id" | "createdAt" | "order" | "parentId">]?:
    | TreeNode[K]
    | null
    | undefined;
};

export type OpBody =
  | { type: "add"; node: TreeNode; index?: number | undefined }
  | { type: "update"; id: NodeId; patch: NodePatch }
  | { type: "move"; id: NodeId; parentId: NodeId | null; index: number }
  | { type: "remove"; id: NodeId };

export type Op = OpBody & { seq: number; ts: number };

export interface Snapshot {
  seq: number;
  ts: number;
  nodes: TreeNode[];
  nodeCount: number;
}

export type Tree = ReadonlyMap<NodeId, TreeNode>;

export class OpError extends Error {
  constructor(
    message: string,
    readonly op?: OpBody,
  ) {
    super(message);
    this.name = "OpError";
  }
}

// ---------------------------------------------------------------------------------------------
// Construction & queries

export function createTree(nodes: Iterable<TreeNode> = []): Tree {
  const map = new Map<NodeId, TreeNode>();
  for (const n of nodes) map.set(n.id, n);
  return map;
}

export function compareSiblings(a: TreeNode, b: TreeNode): number {
  if (a.order !== b.order) return a.order - b.order;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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

/** Nearest ancestor (or self) of kind `window`. */
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

export interface FlatRow {
  node: TreeNode;
  depth: number;
  hasChildren: boolean;
  /** Set when a search is active and this node matched (ancestors of matches are not "matches"). */
  matched: boolean;
}

/**
 * Flatten the tree for rendering. Collapsed nodes hide their children unless a `filter` is
 * active, in which case matching nodes and all their ancestors are shown expanded.
 */
export function flattenTree(tree: Tree, filter?: (n: TreeNode) => boolean): FlatRow[] {
  const rows: FlatRow[] = [];
  let visible: Set<NodeId> | null = null;
  let matches: Set<NodeId> | null = null;
  if (filter) {
    visible = new Set();
    matches = new Set();
    for (const n of tree.values()) {
      if (filter(n)) {
        matches.add(n.id);
        visible.add(n.id);
        for (const a of ancestorsOf(tree, n.id)) visible.add(a.id);
      }
    }
  }
  const index = buildChildIndex(tree);
  const seen = new Set<NodeId>();
  const walk = (parentId: NodeId | null, depth: number): void => {
    for (const n of index.get(parentId) ?? []) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      if (visible && !visible.has(n.id)) continue;
      const kids = index.get(n.id) ?? [];
      rows.push({
        node: n,
        depth,
        hasChildren: kids.length > 0,
        matched: matches ? matches.has(n.id) : false,
      });
      if (visible || !n.collapsed) walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

export function nodeCount(tree: Tree): number {
  return tree.size;
}

export type DropPosition = "before" | "after" | "inside";

export interface DropDestination {
  parentId: NodeId | null;
  index: number;
}

/**
 * Where `draggedId` lands when dropped at `pos` relative to `targetId`; a `null` target appends
 * to the root. Tree placement is presentation only and independent of the browser's window/tab
 * structure, so any node (live window, live tab, saved node, group) may be nested under any other
 * or reordered among any siblings. The only refusals are structural: unknown ids, dropping a node
 * onto itself or into its own subtree, and nesting under a note (notes are leaves). "inside"
 * appends as the last child. Returns `null` when the drop is not allowed.
 */
export function resolveDrop(
  tree: Tree,
  draggedId: NodeId,
  targetId: NodeId | null,
  pos: DropPosition,
  index: ChildIndex = buildChildIndex(tree),
): DropDestination | null {
  if (!tree.has(draggedId)) return null;
  const siblingsOf = (parentId: NodeId | null): TreeNode[] =>
    (index.get(parentId) ?? []).filter((s) => s.id !== draggedId);
  if (targetId === null) return { parentId: null, index: siblingsOf(null).length };
  const target = tree.get(targetId);
  if (!target || draggedId === targetId) return null;
  if (isSelfOrAncestor(tree, draggedId, targetId)) return null;
  if (pos === "inside") {
    if (target.kind === "note") return null;
    return { parentId: target.id, index: siblingsOf(target.id).length };
  }
  const siblings = siblingsOf(target.parentId);
  const at = siblings.findIndex((s) => s.id === targetId);
  if (at < 0) return null;
  return { parentId: target.parentId, index: pos === "before" ? at : at + 1 };
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
    const seen = new Set(out.map((n) => n.id));
    for (const n of tree.values()) if (!seen.has(n.id)) out.push(n);
  }
  return out;
}

/**
 * Structural validation. Returns a list of problems (empty when the tree is consistent).
 */
export function validateTree(tree: Tree): string[] {
  const problems: string[] = [];
  for (const n of tree.values()) {
    if (n.parentId !== null && !tree.has(n.parentId)) {
      problems.push(`node ${n.id} references missing parent ${n.parentId}`);
    }
    if (n.parentId === n.id) problems.push(`node ${n.id} is its own parent`);
  }
  // Cycle detection.
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

// ---------------------------------------------------------------------------------------------
// Mutations (pure: return a new tree)

function renumber(map: Map<NodeId, TreeNode>, parentId: NodeId | null, ts: number): void {
  const kids = childrenOf(map, parentId);
  kids.forEach((k, i) => {
    if (k.order !== i) map.set(k.id, { ...k, order: i, updatedAt: ts });
  });
}

function insertAt(
  map: Map<NodeId, TreeNode>,
  node: TreeNode,
  parentId: NodeId | null,
  index: number | undefined,
  ts: number,
): void {
  const siblings = childrenOf(map, parentId).filter((s) => s.id !== node.id);
  const at = index === undefined ? siblings.length : Math.max(0, Math.min(index, siblings.length));
  siblings.splice(at, 0, { ...node, parentId });
  siblings.forEach((s, i) => {
    map.set(s.id, s.order === i && s.id !== node.id ? s : { ...s, order: i, updatedAt: ts });
  });
}

function applyOpMut(map: Map<NodeId, TreeNode>, op: OpBody, ts: number): void {
  switch (op.type) {
    case "add": {
      const { node } = op;
      if (map.has(node.id)) throw new OpError(`add: node ${node.id} already exists`, op);
      if (node.parentId !== null && !map.has(node.parentId)) {
        throw new OpError(`add: parent ${node.parentId} does not exist`, op);
      }
      insertAt(map, node, node.parentId, op.index, ts);
      return;
    }
    case "update": {
      const cur = map.get(op.id);
      if (!cur) throw new OpError(`update: node ${op.id} does not exist`, op);
      const next: Record<string, unknown> = { ...cur, updatedAt: ts };
      for (const [k, v] of Object.entries(op.patch)) {
        if (
          k === "updatedAt" ||
          k === "id" ||
          k === "createdAt" ||
          k === "order" ||
          k === "parentId"
        ) {
          continue;
        }
        if (v === undefined || v === null) delete next[k];
        else next[k] = v;
      }
      map.set(cur.id, next as unknown as TreeNode);
      return;
    }
    case "move": {
      const cur = map.get(op.id);
      if (!cur) throw new OpError(`move: node ${op.id} does not exist`, op);
      if (op.parentId !== null) {
        if (!map.has(op.parentId)) throw new OpError(`move: parent ${op.parentId} missing`, op);
        if (isSelfOrAncestor(map, op.id, op.parentId)) {
          throw new OpError(`move: cannot move ${op.id} into its own subtree`, op);
        }
      }
      const oldParent = cur.parentId;
      insertAt(map, { ...cur, updatedAt: ts }, op.parentId, op.index, ts);
      if (oldParent !== op.parentId) renumber(map, oldParent, ts);
      return;
    }
    case "remove": {
      const cur = map.get(op.id);
      if (!cur) throw new OpError(`remove: node ${op.id} does not exist`, op);
      for (const id of descendantIds(map, op.id)) map.delete(id);
      map.delete(op.id);
      renumber(map, cur.parentId, ts);
      return;
    }
  }
}

/** Apply one op and return the resulting tree. Throws `OpError` when the op is invalid. */
export function applyOp(tree: Tree, op: OpBody, ts = Date.now()): Tree {
  const map = new Map(tree);
  applyOpMut(map, op, ts);
  return map;
}

/** Apply many ops; all-or-nothing. */
export function applyOps(tree: Tree, ops: readonly (OpBody & { ts?: number })[]): Tree {
  const map = new Map(tree);
  for (const op of ops) applyOpMut(map, op, op.ts ?? Date.now());
  return map;
}

// ---------------------------------------------------------------------------------------------
// Op builders

export interface NewNodeInput {
  id: NodeId;
  parentId: NodeId | null;
  kind: NodeKind;
  title: string;
  url?: string | undefined;
  favIconUrl?: string | undefined;
  note?: string | undefined;
  collapsed?: boolean | undefined;
  liveTabId?: number | undefined;
  liveWindowId?: number | undefined;
  ts?: number | undefined;
}

export function makeNode(input: NewNodeInput): TreeNode {
  const ts = input.ts ?? Date.now();
  const node: TreeNode = {
    id: input.id,
    parentId: input.parentId,
    kind: input.kind,
    title: input.title,
    createdAt: ts,
    updatedAt: ts,
    order: 0,
  };
  if (input.url !== undefined) node.url = input.url;
  if (input.favIconUrl !== undefined) node.favIconUrl = input.favIconUrl;
  if (input.note !== undefined) node.note = input.note;
  if (input.collapsed !== undefined) node.collapsed = input.collapsed;
  if (input.liveTabId !== undefined) node.liveTabId = input.liveTabId;
  if (input.liveWindowId !== undefined) node.liveWindowId = input.liveWindowId;
  return node;
}

export const ops = {
  add(node: TreeNode, index?: number): OpBody {
    return index === undefined ? { type: "add", node } : { type: "add", node, index };
  },
  update(id: NodeId, patch: NodePatch): OpBody {
    return { type: "update", id, patch };
  },
  move(id: NodeId, parentId: NodeId | null, index: number): OpBody {
    return { type: "move", id, parentId, index };
  },
  remove(id: NodeId): OpBody {
    return { type: "remove", id };
  },
  /** UI ops cross `runtime.sendMessage`, so "clear" is encoded as `null` (see `NodePatch`). */
  collapse(id: NodeId, collapsed: boolean): OpBody {
    return { type: "update", id, patch: { collapsed: collapsed ? true : null } };
  },
  note(id: NodeId, note: string): OpBody {
    const text = note.trim();
    return { type: "update", id, patch: { note: text ? text : null } };
  },
};

/** Ensure a value parsed from JSON is a TreeNode; returns undefined otherwise. */
export function coerceNode(value: unknown): TreeNode | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !v.id) return undefined;
  if (!(v.parentId === null || typeof v.parentId === "string")) return undefined;
  const kind = v.kind;
  if (kind !== "window" && kind !== "tab" && kind !== "group" && kind !== "note") return undefined;
  const now = Date.now();
  const node: TreeNode = {
    id: v.id,
    parentId: v.parentId as NodeId | null,
    kind,
    title: typeof v.title === "string" ? v.title : "",
    createdAt: typeof v.createdAt === "number" ? v.createdAt : now,
    updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : now,
    order: typeof v.order === "number" ? v.order : 0,
  };
  if (typeof v.url === "string") node.url = v.url;
  if (typeof v.favIconUrl === "string") node.favIconUrl = v.favIconUrl;
  if (typeof v.note === "string") node.note = v.note;
  if (v.collapsed === true) node.collapsed = true;
  if (typeof v.liveTabId === "number") node.liveTabId = v.liveTabId;
  if (typeof v.liveWindowId === "number") node.liveWindowId = v.liveWindowId;
  return node;
}

/** Ensure a value parsed from storage is an Op; returns undefined otherwise. */
export function coerceOp(value: unknown): Op | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.seq !== "number" || typeof v.ts !== "number") return undefined;
  const base = { seq: v.seq, ts: v.ts };
  switch (v.type) {
    case "add": {
      const node = coerceNode(v.node);
      if (!node) return undefined;
      return typeof v.index === "number"
        ? { ...base, type: "add", node, index: v.index }
        : { ...base, type: "add", node };
    }
    case "update":
      if (typeof v.id !== "string" || typeof v.patch !== "object" || v.patch === null) {
        return undefined;
      }
      return { ...base, type: "update", id: v.id, patch: v.patch as NodePatch };
    case "move":
      if (
        typeof v.id !== "string" ||
        !(v.parentId === null || typeof v.parentId === "string") ||
        typeof v.index !== "number"
      ) {
        return undefined;
      }
      return {
        ...base,
        type: "move",
        id: v.id,
        parentId: v.parentId as NodeId | null,
        index: v.index,
      };
    case "remove":
      if (typeof v.id !== "string") return undefined;
      return { ...base, type: "remove", id: v.id };
    default:
      return undefined;
  }
}

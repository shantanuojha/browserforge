/**
 * Mutations. Every change to a tree is an `OpBody`; `applyOp` runs the handler for its kind and
 * returns a new tree. Adding an op kind means adding a handler to `APPLIERS`, nothing else.
 */
import { childrenOf, descendantIds, isSelfOrAncestor } from "./queries";
import {
  OpError,
  type NodeId,
  type NodeKind,
  type NodePatch,
  type OpBody,
  type OpOf,
  type OpType,
  type Tree,
  type TreeNode,
} from "./types";

type MutableTree = Map<NodeId, TreeNode>;

interface Placement {
  parentId: NodeId | null;
  /** `undefined` appends. */
  index: number | undefined;
}

function renumber(map: MutableTree, parentId: NodeId | null, ts: number): void {
  const kids = childrenOf(map, parentId);
  kids.forEach((k, i) => {
    if (k.order !== i) map.set(k.id, { ...k, order: i, updatedAt: ts });
  });
}

function insertAt(map: MutableTree, node: TreeNode, at: Placement, ts: number): void {
  const siblings = childrenOf(map, at.parentId).filter((s) => s.id !== node.id);
  const index =
    at.index === undefined ? siblings.length : Math.max(0, Math.min(at.index, siblings.length));
  siblings.splice(index, 0, { ...node, parentId: at.parentId });
  siblings.forEach((s, i) => {
    map.set(s.id, s.order === i && s.id !== node.id ? s : { ...s, order: i, updatedAt: ts });
  });
}

/** Fields a patch may never touch: identity, creation time and the sibling bookkeeping. */
const PROTECTED_FIELDS = new Set(["updatedAt", "id", "createdAt", "order", "parentId"]);

function patched(cur: TreeNode, patch: NodePatch, ts: number): TreeNode {
  const next: Record<string, unknown> = { ...cur, updatedAt: ts };
  for (const [k, v] of Object.entries(patch)) {
    if (PROTECTED_FIELDS.has(k)) continue;
    if (v === undefined || v === null) delete next[k];
    else next[k] = v;
  }
  return next as unknown as TreeNode;
}

function existing(map: MutableTree, id: NodeId, op: OpBody): TreeNode {
  const cur = map.get(id);
  if (!cur) throw new OpError(`${op.type}: node ${id} does not exist`, op);
  return cur;
}

type Applier<T extends OpType> = (map: MutableTree, op: OpOf<T>, ts: number) => void;

const APPLIERS: { [T in OpType]: Applier<T> } = {
  add(map, op, ts) {
    const { node } = op;
    if (map.has(node.id)) throw new OpError(`add: node ${node.id} already exists`, op);
    if (node.parentId !== null && !map.has(node.parentId)) {
      throw new OpError(`add: parent ${node.parentId} does not exist`, op);
    }
    insertAt(map, node, { parentId: node.parentId, index: op.index }, ts);
  },
  update(map, op, ts) {
    const cur = existing(map, op.id, op);
    map.set(cur.id, patched(cur, op.patch, ts));
  },
  move(map, op, ts) {
    const cur = existing(map, op.id, op);
    if (op.parentId !== null) {
      if (!map.has(op.parentId)) throw new OpError(`move: parent ${op.parentId} missing`, op);
      if (isSelfOrAncestor(map, op.id, op.parentId)) {
        throw new OpError(`move: cannot move ${op.id} into its own subtree`, op);
      }
    }
    const oldParent = cur.parentId;
    insertAt(map, { ...cur, updatedAt: ts }, { parentId: op.parentId, index: op.index }, ts);
    if (oldParent !== op.parentId) renumber(map, oldParent, ts);
  },
  remove(map, op, ts) {
    const cur = existing(map, op.id, op);
    for (const id of descendantIds(map, op.id)) map.delete(id);
    map.delete(op.id);
    renumber(map, cur.parentId, ts);
  },
};

function applyOpMut(map: MutableTree, op: OpBody, ts: number): void {
  // The table is keyed by `type`, so the cast only re-associates the op with its own handler.
  (APPLIERS[op.type] as Applier<OpType>)(map, op, ts);
}

/** Apply one op and return the resulting tree. Throws `OpError` when the op is invalid. */
export function applyOp(tree: Tree, op: OpBody, ts: number): Tree {
  const map = new Map(tree);
  applyOpMut(map, op, ts);
  return map;
}

/** Apply many ops; all-or-nothing. Ops without their own `ts` are stamped with `ts`. */
export function applyOps(tree: Tree, ops: readonly (OpBody & { ts?: number })[], ts: number): Tree {
  const map = new Map(tree);
  for (const op of ops) applyOpMut(map, op, op.ts ?? ts);
  return map;
}

// ---------------------------------------------------------------------------------------------
// Builders

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
  /** Creation time; also the initial `updatedAt`. */
  ts: number;
}

/** A node with only the optional fields that were given (never `key: undefined`). */
export function makeNode(input: NewNodeInput): TreeNode {
  const node: TreeNode = {
    id: input.id,
    parentId: input.parentId,
    kind: input.kind,
    title: input.title,
    createdAt: input.ts,
    updatedAt: input.ts,
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

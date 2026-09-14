/**
 * Inverting tree edits. An undo is the *inverse* of what an action did, expressed as ordinary
 * ops appended to the same op log: re-adding a deleted subtree is a batch of `add` ops with the
 * original ids; undoing a move is a move back.
 */
import {
  applyOp,
  childrenOf,
  descendantIds,
  ops,
  type NodeId,
  type NodePatch,
  type OpBody,
  type OpOf,
  type OpType,
  type Tree,
  type TreeNode,
} from "../model";

/** A node as it is re-added: same id and place, but saved (its browser tab is gone). */
export function asSaved(node: TreeNode): TreeNode {
  const copy = { ...node };
  delete copy.liveTabId;
  delete copy.liveWindowId;
  return copy;
}

/** Index of `node` among its siblings in `tree`, or its stored order when it is not there. */
export function siblingIndex(tree: Tree, node: TreeNode): number {
  const i = tree.has(node.id)
    ? childrenOf(tree, node.parentId).findIndex((s) => s.id === node.id)
    : -1;
  return i >= 0 ? i : node.order;
}

/**
 * Ops that put `removed` back where they were. `removed` must list parents before children (as
 * `TabTracker.deleteNode` / `moveNode` return them); roots are inserted at the index they had
 * in `before`, descendants are appended in order under their re-added parents.
 */
export function readdOps(before: Tree, removed: readonly TreeNode[]): OpBody[] {
  const set = new Set(removed.map((n) => n.id));
  return removed.map((n) =>
    n.parentId !== null && set.has(n.parentId)
      ? ops.add(asSaved(n))
      : ops.add(asSaved(n), siblingIndex(before, n)),
  );
}

/** The subtree rooted at `id`, parents before children. */
function subtreeOf(tree: Tree, root: TreeNode): TreeNode[] {
  return [root, ...descendantIds(tree, root.id).map((id) => tree.get(id) as TreeNode)];
}

/** The ops that undo one op applied to `tree`; empty when the op referred to a missing node. */
type Inverter<T extends OpType> = (tree: Tree, op: OpOf<T>) => OpBody[];

const INVERTERS: { [T in OpType]: Inverter<T> } = {
  add: (_tree, op) => [ops.remove(op.node.id)],
  update(tree, op) {
    const cur = tree.get(op.id);
    if (!cur) return [];
    const patch: NodePatch = {};
    for (const key of Object.keys(op.patch) as (keyof NodePatch)[]) {
      const old = cur[key];
      (patch as Record<string, unknown>)[key] = old === undefined ? null : old;
    }
    return [ops.update(op.id, patch)];
  },
  move(tree, op) {
    const cur = tree.get(op.id);
    return cur ? [ops.move(op.id, cur.parentId, siblingIndex(tree, cur))] : [];
  },
  remove(tree, op) {
    const root = tree.get(op.id);
    return root ? readdOps(tree, subtreeOf(tree, root)) : [];
  },
};

/** Advance the working tree past `op` so the next inverse sees the right state; skip bad ops. */
function applyForInverse(tree: Tree, op: OpBody): Tree {
  try {
    return applyOp(tree, op, 0);
  } catch {
    return tree;
  }
}

/**
 * Inverse of a batch applied to `before`, as ops that turn the resulting tree back into `before`.
 * Handles every op kind; removed subtrees come back saved.
 */
export function inverseOps(before: Tree, applied: readonly OpBody[]): OpBody[] {
  const inverses: OpBody[][] = [];
  let tree = before;
  for (const op of applied) {
    const inverse = (INVERTERS[op.type] as Inverter<OpType>)(tree, op);
    if (inverse.length) inverses.push(inverse);
    tree = applyForInverse(tree, op);
  }
  return inverses.reverse().flat();
}

/** Tab nodes at or beneath `id` that are open (`liveTabId` set), in depth-first order. */
export function liveTabNodesIn(tree: Tree, id: NodeId): TreeNode[] {
  const self = tree.get(id);
  if (!self) return [];
  return subtreeOf(tree, self).filter((n) => n.kind === "tab" && n.liveTabId !== undefined);
}

/**
 * Saved tab nodes with a url at or beneath `id` (the ones restoring a tab or note opens). For a
 * container use `containerTabs`: its Reopen all leaves nested containers alone.
 */
export function savedTabNodesIn(tree: Tree, id: NodeId): TreeNode[] {
  const self = tree.get(id);
  if (!self) return [];
  return subtreeOf(tree, self).filter(
    (n) => n.kind === "tab" && n.liveTabId === undefined && !!n.url,
  );
}

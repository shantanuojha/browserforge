/** Where a drag-and-drop lands. Presentation only: the tracker decides what the browser does. */
import { buildChildIndex, isSelfOrAncestor, type ChildIndex } from "./queries";
import type { NodeId, Tree, TreeNode } from "./types";

export type DropPosition = "before" | "after" | "inside";

export interface DropDestination {
  parentId: NodeId | null;
  index: number;
}

export interface DropRequest {
  draggedId: NodeId;
  /** `null` appends to the root. */
  targetId: NodeId | null;
  pos: DropPosition;
}

/**
 * Where `draggedId` lands when dropped at `pos` relative to `targetId`; a `null` target appends
 * to the root. Tree placement is presentation only and independent of the browser's window/tab
 * structure, so any node (bound or unbound container, live tab, saved node) may be nested under
 * any other or reordered among any siblings. The only refusals are structural: unknown ids,
 * dropping a node onto itself or into its own subtree, and nesting under a note (notes are
 * leaves). "inside" appends as the last child. Returns `null` when the drop is not allowed.
 */
export function resolveDrop(
  tree: Tree,
  { draggedId, targetId, pos }: DropRequest,
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

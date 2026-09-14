import {
  useCallback,
  useMemo,
  useState,
  type Dispatch,
  type DragEvent,
  type SetStateAction,
} from "react";
import {
  resolveDrop,
  type ChildIndex,
  type DropDestination,
  type DropPosition,
  type NodeId,
  type Tree,
  type TreeNode,
} from "@/lib/model";
import { ROW_HEIGHT } from "@/lib/tree-layout";

export interface DragState {
  id: NodeId;
  over: { id: NodeId; pos: DropPosition } | null;
  overRoot: boolean;
}

/** Drag handlers a row attaches to its element. */
export interface RowDragHandlers {
  onDragStart(id: NodeId, e: DragEvent): void;
  onDragOver(id: NodeId, e: DragEvent): void;
  onDragLeave(id: NodeId): void;
  onDrop(id: NodeId, e: DragEvent): void;
}

/** Drag handlers for the tree container: the empty space below the rows drops at the root. */
export interface ContainerDragHandlers {
  onDragEnd(): void;
  onDragOver(e: DragEvent): void;
  onDrop(e: DragEvent): void;
}

export interface TreeDrag {
  drag: DragState | null;
  row: RowDragHandlers;
  container: ContainerDragHandlers;
}

export interface TreeDragDeps {
  tree: Tree;
  childIndex: ChildIndex;
  move(id: NodeId, parentId: NodeId | null, index: number): void;
  select(id: NodeId): void;
}

const DATA_TYPE = "text/plain";

/** Where on the hovered row the pointer is: the top and bottom bands mean before/after. */
function positionFor(e: DragEvent, target: TreeNode): DropPosition {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const y = (e.clientY - rect.top) / Math.min(rect.height, ROW_HEIGHT);
  if (target.kind === "note") return y < 0.5 ? "before" : "after";
  if (y < 0.28) return "before";
  if (y > 0.72) return "after";
  return "inside";
}

const overRow = (e: DragEvent): boolean => !!(e.target as HTMLElement).closest(".row");

/**
 * Drag-and-drop within the tree. Placement is presentation only: every node kind may be nested
 * under a container (or any non-note node) or reordered among any siblings. `resolveDrop` only
 * refuses cycles and nesting under a note; whether the real browser tab follows is decided by
 * the tracker on `move`.
 */
export function useTreeDrag({ tree, childIndex, move, select }: TreeDragDeps): TreeDrag {
  const [drag, setDrag] = useState<DragState | null>(null);
  const draggedId = drag?.id;

  const dropTarget = useCallback(
    (dragged: NodeId, targetId: NodeId | null, pos: DropPosition): DropDestination | null =>
      resolveDrop(tree, { draggedId: dragged, targetId, pos }, childIndex),
    [tree, childIndex],
  );

  const row = useMemo<RowDragHandlers>(
    () => ({
      onDragStart(id, e) {
        e.dataTransfer.setData(DATA_TYPE, id);
        e.dataTransfer.effectAllowed = "move";
        setDrag({ id, over: null, overRoot: false });
        select(id);
      },
      onDragOver(id, e) {
        const dragged = draggedId ?? e.dataTransfer.getData(DATA_TYPE);
        const target = tree.get(id);
        if (!dragged || !target) return;
        const pos = positionFor(e, target);
        if (!dropTarget(dragged, id, pos)) {
          setDrag((d) => (d && d.over ? { ...d, over: null } : d));
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDrag((d) =>
          d && d.over?.id === id && d.over.pos === pos
            ? d
            : { id: dragged, over: { id, pos }, overRoot: false },
        );
      },
      onDragLeave(id) {
        setDrag((d) => (d && d.over?.id === id ? { ...d, over: null } : d));
      },
      onDrop(id, e) {
        e.preventDefault();
        const dragged = draggedId ?? e.dataTransfer.getData(DATA_TYPE);
        const target = tree.get(id);
        setDrag(null);
        if (!dragged || !target) return;
        const dest = dropTarget(dragged, id, positionFor(e, target));
        if (dest) move(dragged, dest.parentId, dest.index);
      },
    }),
    [tree, draggedId, dropTarget, move, select],
  );

  return { drag, row, container: rootDropHandlers({ drag, setDrag, dropTarget, move }) };
}

interface RootDropDeps {
  drag: DragState | null;
  setDrag: Dispatch<SetStateAction<DragState | null>>;
  dropTarget(dragged: NodeId, targetId: NodeId | null, pos: DropPosition): DropDestination | null;
  move: TreeDragDeps["move"];
}

/** Empty space below the rows: drop at the root. Events over a row are the row's business. */
function rootDropHandlers({
  drag,
  setDrag,
  dropTarget,
  move,
}: RootDropDeps): ContainerDragHandlers {
  return {
    onDragEnd: () => setDrag(null),
    onDragOver(e) {
      if (!drag || overRow(e)) return;
      if (dropTarget(drag.id, null, "inside")) {
        e.preventDefault();
        setDrag((d) => (d && !d.overRoot ? { ...d, over: null, overRoot: true } : d));
      }
    },
    onDrop(e) {
      if (!drag || overRow(e)) return;
      e.preventDefault();
      const dest = dropTarget(drag.id, null, "inside");
      setDrag(null);
      if (dest) move(drag.id, dest.parentId, dest.index);
    },
  };
}

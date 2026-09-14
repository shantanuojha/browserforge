import type { KeyboardEvent } from "react";
import { deleteKeyAction, type ContainerAction } from "@/lib/container-actions";
import type { FlatRow, NodeId, TreeNode } from "@/lib/model";
import { ROW_HEIGHT } from "@/lib/tree-layout";

export interface TreeKeyboardDeps {
  rows: readonly FlatRow[];
  focusedId: NodeId | null;
  /** A search is active: collapsing is disabled because matches must stay visible. */
  searching: boolean;
  viewport: number;
  focusRow(i: number): void;
  clearFocus(): void;
  startRenaming(id: NodeId): void;
  startEditingNote(id: NodeId): void;
  toggleCollapse(id: NodeId, collapsed: boolean): void;
  primary(id: NodeId): void;
  closeAndSave(id: NodeId): void;
  deleteNode(id: NodeId): void;
  actionsFor(node: TreeNode): ContainerAction[] | null;
}

/** Where a navigation key moves the selection from row `i` (`-1`: nothing selected). */
function navigationTarget(key: string, i: number, count: number, pageStep: number): number | null {
  switch (key) {
    case "ArrowDown":
      return i < 0 ? 0 : i + 1;
    case "ArrowUp":
      return i < 0 ? count - 1 : i - 1;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "PageDown":
      return i < 0 ? 0 : i + pageStep;
    case "PageUp":
      return Math.max(0, i - pageStep);
    default:
      return null;
  }
}

interface RowKeyContext {
  e: KeyboardEvent<HTMLDivElement>;
  row: FlatRow;
  node: TreeNode;
  i: number;
  deps: TreeKeyboardDeps;
}

type RowKeyHandler = (ctx: RowKeyContext) => void;

/** Delete key: close-and-save while anything beneath is open, delete otherwise. */
function deleteOrClose({ node, deps }: RowKeyContext): void {
  const container = deps.actionsFor(node);
  if (container) {
    deleteKeyAction(container)?.run();
  } else if (node.kind === "tab" && node.liveTabId !== undefined) {
    deps.closeAndSave(node.id);
  } else {
    deps.deleteNode(node.id);
  }
}

/** N opens the note editor; with a modifier it keeps its browser meaning (new window...). */
const noteKey: RowKeyHandler = ({ e, node, deps }) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  e.preventDefault();
  deps.startEditingNote(node.id);
};

const ROW_KEYS: Record<string, RowKeyHandler> = {
  ArrowRight({ e, row, node, i, deps }) {
    e.preventDefault();
    if (row.hasChildren && node.collapsed) deps.toggleCollapse(node.id, false);
    else if (row.hasChildren) deps.focusRow(i + 1);
  },
  ArrowLeft({ e, row, node, deps }) {
    e.preventDefault();
    if (row.hasChildren && !node.collapsed && !deps.searching) {
      deps.toggleCollapse(node.id, true);
    } else if (node.parentId) {
      const p = deps.rows.findIndex((r) => r.node.id === node.parentId);
      if (p >= 0) deps.focusRow(p);
    }
  },
  " "({ e, row, node, deps }) {
    e.preventDefault();
    if (row.hasChildren) deps.toggleCollapse(node.id, !node.collapsed);
  },
  Enter({ e, node, deps }) {
    e.preventDefault();
    if (e.shiftKey && node.kind !== "tab") deps.startRenaming(node.id);
    else deps.primary(node.id);
  },
  Delete(ctx) {
    ctx.e.preventDefault();
    deleteOrClose(ctx);
  },
  Backspace(ctx) {
    ctx.e.preventDefault();
    deleteOrClose(ctx);
  },
  F2({ e, node, deps }) {
    e.preventDefault();
    if (node.kind !== "tab") deps.startRenaming(node.id);
  },
  n: noteKey,
  N: noteKey,
  Escape({ deps }) {
    deps.clearFocus();
  },
};

const inTextField = (target: EventTarget): boolean => {
  const tag = (target as HTMLElement).tagName;
  return tag === "INPUT" || tag === "TEXTAREA";
};

/**
 * Keyboard navigation and commands for the tree: arrows and Home/End/Page move the selection,
 * the row keys act on the selected node. Returns the `onKeyDown` handler of the tree element.
 */
export function useTreeKeyboard(
  deps: TreeKeyboardDeps,
): (e: KeyboardEvent<HTMLDivElement>) => void {
  return (e) => {
    if (inTextField(e.target)) return;
    const { rows, focusedId } = deps;
    if (!rows.length) return;
    const i = focusedId ? rows.findIndex((r) => r.node.id === focusedId) : -1;
    const pageStep = Math.max(1, Math.floor(deps.viewport / ROW_HEIGHT) - 1);
    const target = navigationTarget(e.key, i, rows.length, pageStep);
    if (target !== null) {
      e.preventDefault();
      deps.focusRow(target);
      return;
    }
    const row = i >= 0 ? rows[i] : undefined;
    if (!row) {
      if (e.key === "Enter" || e.key === " ") deps.focusRow(0);
      return;
    }
    const handler = Object.hasOwn(ROW_KEYS, e.key) ? ROW_KEYS[e.key] : undefined;
    handler?.({ e, row, node: row.node, i, deps });
  };
}

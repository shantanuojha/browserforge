import { useCallback, useMemo, useState } from "react";
import { useTreeDrag } from "@/hooks/useTreeDrag";
import { useTreeKeyboard } from "@/hooks/useTreeKeyboard";
import { useTreeSelection, type SelectionApi } from "@/hooks/useTreeSelection";
import { useVirtualRows } from "@/hooks/useVirtualRows";
import {
  containerActions,
  isContainer,
  type ContainerAction,
  type ContainerActionHandlers,
} from "@/lib/container-actions";
import {
  buildChildIndex,
  flattenTree,
  type ChildIndex,
  type NodeId,
  type Tree,
  type TreeNode,
} from "@/lib/model";
import type { LiveState } from "@/lib/sync/tracker";
import { ROW_HEIGHT } from "@/lib/tree-layout";
import { buildContextMenu, type MenuEntry } from "@/lib/tree-menu";
import { searchMatcher } from "@/lib/tree-search";
import { ContextMenu } from "./ContextMenu";
import { TreeRow, type RowCallbacks } from "./TreeRow";

/** Return keyboard focus to the tree after an inline editor closes (one tree per page). */
function focusTree(): void {
  document.querySelector<HTMLElement>('[role="tree"]')?.focus({ preventScroll: true });
}

export interface TreeActions {
  toggleCollapse(id: NodeId, collapsed: boolean): void;
  setNote(id: NodeId, note: string): void;
  rename(id: NodeId, title: string): void;
  /** Enter / double-click: focus a live tab, restore a saved one. */
  primary(id: NodeId): void;
  closeAndSave(id: NodeId): void;
  restore(id: NodeId): void;
  /**
   * Container action: reopen a container's closed tabs, into its window when it is open, as a
   * new window otherwise.
   */
  reopenAll(id: NodeId): void;
  deleteNode(id: NodeId): void;
  move(id: NodeId, parentId: NodeId | null, index: number): void;
  /** A new group: an unbound container the user names. */
  addGroup(parentId: NodeId | null, index: number): void;
  addNote(parentId: NodeId, index: number): void;
}

export interface TreeViewProps {
  tree: Tree;
  live: LiveState;
  query: string;
  actions: TreeActions;
  faviconFallback: ((url: string) => string) | null;
}

interface MenuAnchor {
  id: NodeId;
  x: number;
  y: number;
}

type EditCallbacks = Omit<RowCallbacks, "onDragStart" | "onDragOver" | "onDragLeave" | "onDrop">;

/** Row callbacks other than drag-and-drop: selection, editing and the node actions. */
function useRowCallbacks(
  tree: Tree,
  actions: TreeActions,
  selection: SelectionApi,
  openMenu: (anchor: MenuAnchor) => void,
): EditCallbacks {
  return useMemo(
    () => ({
      onSelect: (id) => {
        selection.setFocusedId(id);
        focusTree();
      },
      onPrimary: (id) => actions.primary(id),
      onToggle: (id) => {
        const n = tree.get(id);
        if (n) actions.toggleCollapse(id, !n.collapsed);
      },
      onContextMenu: (id, x, y) => {
        selection.setFocusedId(id);
        openMenu({ id, x, y });
      },
      onCloseAndSave: (id) => actions.closeAndSave(id),
      onRestore: (id) => actions.restore(id),
      onReopenAll: (id) => actions.reopenAll(id),
      onDelete: (id) => actions.deleteNode(id),
      onEditNote: (id) => selection.startEditingNote(id),
      onSaveNote: (id, note) => {
        selection.setEditingNoteId(null);
        const current = tree.get(id)?.note ?? "";
        if (note.trim() !== current.trim()) actions.setNote(id, note.trim());
        focusTree();
      },
      onStartRename: (id) => {
        const n = tree.get(id);
        if (!n || n.kind === "tab") return;
        selection.startRenaming(id);
      },
      onRename: (id, title) => {
        selection.setRenamingId(null);
        actions.rename(id, title);
        focusTree();
      },
      onCancelEdit: () => {
        selection.stopEditing();
        focusTree();
      },
    }),
    [actions, tree, selection, openMenu],
  );
}

/** One definition of the container actions drives row buttons, keyboard and context menu alike. */
function useContainerActions(
  tree: Tree,
  childIndex: ChildIndex,
  cb: RowCallbacks,
  actions: TreeActions,
): (node: TreeNode) => ContainerAction[] | null {
  const handlers = useMemo<ContainerActionHandlers>(
    () => ({
      reopenAll: cb.onReopenAll,
      closeAndSave: cb.onCloseAndSave,
      editNote: cb.onEditNote,
      startRename: cb.onStartRename,
      toggleCollapse: (id, collapsed) => actions.toggleCollapse(id, collapsed),
      deleteNode: cb.onDelete,
    }),
    [cb, actions],
  );
  return useCallback(
    (node: TreeNode) =>
      isContainer(node) ? containerActions(tree, node, handlers, childIndex) : null,
    [tree, childIndex, handlers],
  );
}

interface ContextMenuDeps {
  menu: MenuAnchor | null;
  tree: Tree;
  childIndex: ChildIndex;
  actions: TreeActions;
  actionsFor(node: TreeNode): ContainerAction[] | null;
  selection: SelectionApi;
}

function useContextMenuItems(deps: ContextMenuDeps): MenuEntry[] {
  const { menu, tree, childIndex, actions, actionsFor, selection } = deps;
  return useMemo<MenuEntry[]>(() => {
    const node = menu ? tree.get(menu.id) : undefined;
    if (!node) return [];
    return buildContextMenu({
      node,
      childIndex,
      containerActions: actionsFor(node),
      handlers: {
        primary: actions.primary,
        closeAndSave: actions.closeAndSave,
        restore: actions.restore,
        deleteNode: actions.deleteNode,
        toggleCollapse: actions.toggleCollapse,
        editNote: selection.setEditingNoteId,
        startRename: selection.setRenamingId,
        addGroup: actions.addGroup,
        addNote: actions.addNote,
      },
    });
  }, [menu, tree, childIndex, actions, actionsFor, selection]);
}

export function TreeView({ tree, live, query, actions, faviconFallback }: TreeViewProps) {
  const { ids, api: selection } = useTreeSelection(tree);
  const { focusedId, editingNoteId, renamingId } = ids;
  const [menu, setMenu] = useState<MenuAnchor | null>(null);

  const filter = useMemo(() => searchMatcher(query), [query]);
  const rows = useMemo(() => flattenTree(tree, filter), [tree, filter]);
  const childIndex = useMemo(() => buildChildIndex(tree), [tree]);
  const activeTabs = useMemo(() => new Set(live.activeTabIds), [live.activeTabIds]);

  const { containerRef, layout, visibleIndices, viewport, onScroll, scrollRowIntoView } =
    useVirtualRows(rows, editingNoteId);
  const focusRow = useCallback(
    (i: number) => {
      const row = rows[Math.max(0, Math.min(i, rows.length - 1))];
      if (!row) return;
      selection.setFocusedId(row.node.id);
      scrollRowIntoView(rows.indexOf(row));
    },
    [rows, selection, scrollRowIntoView],
  );

  const drag = useTreeDrag({
    tree,
    childIndex,
    move: actions.move,
    select: selection.setFocusedId,
  });
  const edits = useRowCallbacks(tree, actions, selection, setMenu);
  const cb = useMemo<RowCallbacks>(() => ({ ...edits, ...drag.row }), [edits, drag.row]);
  const actionsFor = useContainerActions(tree, childIndex, cb, actions);

  const onKeyDown = useTreeKeyboard({
    rows,
    focusedId,
    searching: filter !== undefined,
    viewport,
    focusRow,
    clearFocus: () => selection.setFocusedId(null),
    startRenaming: selection.setRenamingId,
    startEditingNote: selection.setEditingNoteId,
    toggleCollapse: actions.toggleCollapse,
    primary: actions.primary,
    closeAndSave: actions.closeAndSave,
    deleteNode: actions.deleteNode,
    actionsFor,
  });

  const menuItems = useContextMenuItems({
    menu,
    tree,
    childIndex,
    actions,
    actionsFor,
    selection,
  });

  const { offsets, heights, total } = layout;
  const rootDropClass = drag.drag?.overRoot
    ? "tree__root-drop tree__root-drop--over"
    : "tree__root-drop";

  return (
    <>
      <div
        ref={containerRef}
        className="tree"
        role="tree"
        tabIndex={0}
        aria-label="Windows and tabs"
        aria-activedescendant={focusedId ? `row-${focusedId}` : undefined}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        onClick={() => selection.setFocusedId(null)}
        onDragEnd={drag.container.onDragEnd}
        onDragOver={drag.container.onDragOver}
        onDrop={drag.container.onDrop}
      >
        {rows.length === 0 ? (
          <div className="tree__empty">
            {query ? "Nothing matches your search." : "No windows or tabs yet."}
          </div>
        ) : (
          <div className="tree__spacer" style={{ height: total + 40 }}>
            {visibleIndices.map((i) => {
              const row = rows[i];
              if (!row) return null;
              const id = row.node.id;
              return (
                <TreeRow
                  key={id}
                  row={row}
                  top={offsets[i] ?? 0}
                  height={heights[i] ?? ROW_HEIGHT}
                  focused={focusedId === id}
                  active={row.node.liveTabId !== undefined && activeTabs.has(row.node.liveTabId)}
                  editingNote={editingNoteId === id}
                  renaming={renamingId === id}
                  dragging={drag.drag?.id === id}
                  dropPosition={drag.drag?.over?.id === id ? drag.drag.over.pos : null}
                  childCount={childIndex.get(id)?.length ?? 0}
                  containerActions={actionsFor(row.node)}
                  faviconFallback={faviconFallback}
                  cb={cb}
                />
              );
            })}
            <div className={rootDropClass} style={{ top: total }} />
          </div>
        )}
      </div>
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      ) : null}
    </>
  );
}

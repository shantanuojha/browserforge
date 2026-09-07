import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import {
  buildChildIndex,
  flattenTree,
  isSelfOrAncestor,
  windowNodeOf,
  type FlatRow,
  type NodeId,
  type Tree,
  type TreeNode,
} from "@/lib/model";
import type { LiveState } from "@/lib/sync/tracker";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { TreeRow, type DropPosition, type RowCallbacks } from "./TreeRow";

const ROW = 28;
const NOTE_PREVIEW = 22;
const NOTE_EDITOR = 78;
const OVERSCAN = 6;

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
  deleteNode(id: NodeId): void;
  move(id: NodeId, parentId: NodeId | null, index: number): void;
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

function matcher(query: string): ((n: TreeNode) => boolean) | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const terms = q.split(/\s+/);
  return (n) => {
    const hay = `${n.title}\n${n.url ?? ""}\n${n.note ?? ""}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  };
}

interface DragState {
  id: NodeId;
  over: { id: NodeId; pos: DropPosition } | null;
  overRoot: boolean;
}

export function TreeView({ tree, live, query, actions, faviconFallback }: TreeViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rawFocusedId, setFocusedId] = useState<NodeId | null>(null);
  const [rawEditingNoteId, setEditingNoteId] = useState<NodeId | null>(null);
  const [rawRenamingId, setRenamingId] = useState<NodeId | null>(null);
  // Ids are only meaningful while the node exists; derive instead of syncing with an effect.
  const focusedId = rawFocusedId && tree.has(rawFocusedId) ? rawFocusedId : null;
  const editingNoteId = rawEditingNoteId && tree.has(rawEditingNoteId) ? rawEditingNoteId : null;
  const renamingId = rawRenamingId && tree.has(rawRenamingId) ? rawRenamingId : null;
  const [drag, setDrag] = useState<DragState | null>(null);
  const [menu, setMenu] = useState<{ id: NodeId; x: number; y: number } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);

  const filter = useMemo(() => matcher(query), [query]);
  const rows = useMemo(() => flattenTree(tree, filter), [tree, filter]);
  const childIndex = useMemo(() => buildChildIndex(tree), [tree]);
  const activeTabs = useMemo(() => new Set(live.activeTabIds), [live.activeTabIds]);

  // Heights are per-row so note previews / editors can expand a row.
  const layout = useMemo(() => {
    const offsets = new Array<number>(rows.length);
    const heights = new Array<number>(rows.length);
    let y = 0;
    rows.forEach((r, i) => {
      let h = ROW;
      if (editingNoteId === r.node.id) h += NOTE_EDITOR;
      else if (r.node.note) h += NOTE_PREVIEW;
      offsets[i] = y;
      heights[i] = h;
      y += h;
    });
    return { offsets, heights, total: y };
  }, [rows, editingNoteId]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setViewport(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const indexOfRow = useCallback((id: NodeId) => rows.findIndex((r) => r.node.id === id), [rows]);

  const scrollRowIntoView = useCallback(
    (i: number) => {
      const el = containerRef.current;
      if (!el || i < 0) return;
      const top = layout.offsets[i] ?? 0;
      const bottom = top + (layout.heights[i] ?? ROW);
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    },
    [layout],
  );

  const focusRow = useCallback(
    (i: number) => {
      const row = rows[Math.max(0, Math.min(i, rows.length - 1))];
      if (!row) return;
      setFocusedId(row.node.id);
      scrollRowIntoView(rows.indexOf(row));
    },
    [rows, scrollRowIntoView],
  );

  // -- drag & drop -----------------------------------------------------------------------------

  const dropTarget = useCallback(
    (
      draggedId: NodeId,
      targetId: NodeId,
      pos: DropPosition,
    ): { parentId: NodeId | null; index: number } | null => {
      const dragged = tree.get(draggedId);
      const target = tree.get(targetId);
      if (!dragged || !target || draggedId === targetId) return null;
      if (isSelfOrAncestor(tree, draggedId, targetId)) return null;
      if (pos === "inside" && target.kind === "note") return null;
      const parentId = pos === "inside" ? target.id : target.parentId;
      if (dragged.kind === "window" && parentId !== null) return null;
      if (dragged.kind === "tab" && dragged.liveTabId !== undefined) {
        if (parentId === null) return null;
        const win = windowNodeOf(tree, parentId);
        if (!win || win.liveWindowId === undefined) return null;
      }
      const siblings = (childIndex.get(parentId) ?? []).filter((s) => s.id !== draggedId);
      if (pos === "inside") return { parentId, index: siblings.length };
      const at = siblings.findIndex((s) => s.id === targetId);
      return { parentId, index: pos === "before" ? at : at + 1 };
    },
    [tree, childIndex],
  );

  const positionFor = (e: DragEvent, target: TreeNode): DropPosition => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (e.clientY - rect.top) / Math.min(rect.height, ROW);
    if (target.kind === "note") return y < 0.5 ? "before" : "after";
    if (y < 0.28) return "before";
    if (y > 0.72) return "after";
    return "inside";
  };

  const rootDrop = (draggedId: NodeId): { parentId: null; index: number } | null => {
    const dragged = tree.get(draggedId);
    if (!dragged) return null;
    if (dragged.kind === "tab" && dragged.liveTabId !== undefined) return null;
    return {
      parentId: null,
      index: (childIndex.get(null) ?? []).filter((r) => r.id !== draggedId).length,
    };
  };

  // -- row callbacks (stable) -----------------------------------------------------------------

  const cb = useMemo<RowCallbacks>(
    () => ({
      onSelect: (id) => {
        setFocusedId(id);
        focusTree();
      },
      onPrimary: (id) => actions.primary(id),
      onToggle: (id) => {
        const n = tree.get(id);
        if (n) actions.toggleCollapse(id, !n.collapsed);
      },
      onContextMenu: (id, x, y) => {
        setFocusedId(id);
        setMenu({ id, x, y });
      },
      onCloseAndSave: (id) => actions.closeAndSave(id),
      onRestore: (id) => actions.restore(id),
      onDelete: (id) => actions.deleteNode(id),
      onEditNote: (id) => {
        setRenamingId(null);
        setEditingNoteId(id);
        setFocusedId(id);
      },
      onSaveNote: (id, note) => {
        setEditingNoteId(null);
        const current = tree.get(id)?.note ?? "";
        if (note.trim() !== current.trim()) actions.setNote(id, note.trim());
        focusTree();
      },
      onStartRename: (id) => {
        const n = tree.get(id);
        if (!n || n.kind === "tab") return;
        setEditingNoteId(null);
        setRenamingId(id);
      },
      onRename: (id, title) => {
        setRenamingId(null);
        actions.rename(id, title);
        focusTree();
      },
      onCancelEdit: () => {
        setRenamingId(null);
        setEditingNoteId(null);
        focusTree();
      },
      onDragStart: (id, e) => {
        e.dataTransfer.setData("text/plain", id);
        e.dataTransfer.effectAllowed = "move";
        setDrag({ id, over: null, overRoot: false });
        setFocusedId(id);
      },
      onDragOver: (id, e) => {
        const draggedId = drag?.id ?? e.dataTransfer.getData("text/plain");
        const target = tree.get(id);
        if (!draggedId || !target) return;
        const pos = positionFor(e, target);
        if (!dropTarget(draggedId, id, pos)) {
          setDrag((d) => (d && d.over ? { ...d, over: null } : d));
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDrag((d) =>
          d && d.over?.id === id && d.over.pos === pos
            ? d
            : { id: draggedId, over: { id, pos }, overRoot: false },
        );
      },
      onDragLeave: (id) => {
        setDrag((d) => (d && d.over?.id === id ? { ...d, over: null } : d));
      },
      onDrop: (id, e) => {
        e.preventDefault();
        const draggedId = drag?.id ?? e.dataTransfer.getData("text/plain");
        const target = tree.get(id);
        setDrag(null);
        if (!draggedId || !target) return;
        const pos = positionFor(e, target);
        const dest = dropTarget(draggedId, id, pos);
        if (dest) actions.move(draggedId, dest.parentId, dest.index);
      },
    }),
    [actions, tree, drag?.id, dropTarget],
  );

  // -- keyboard -------------------------------------------------------------------------------

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    if (!rows.length) return;
    const i = focusedId ? indexOfRow(focusedId) : -1;
    const row = i >= 0 ? rows[i] : undefined;
    const node = row?.node;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusRow(i < 0 ? 0 : i + 1);
        return;
      case "ArrowUp":
        e.preventDefault();
        focusRow(i < 0 ? rows.length - 1 : i - 1);
        return;
      case "Home":
        e.preventDefault();
        focusRow(0);
        return;
      case "End":
        e.preventDefault();
        focusRow(rows.length - 1);
        return;
      case "PageDown":
      case "PageUp": {
        e.preventDefault();
        const step = Math.max(1, Math.floor(viewport / ROW) - 1);
        focusRow(e.key === "PageDown" ? (i < 0 ? 0 : i + step) : Math.max(0, i - step));
        return;
      }
    }
    if (!node || !row) {
      if (e.key === "Enter" || e.key === " ") focusRow(0);
      return;
    }
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        if (row.hasChildren && node.collapsed) actions.toggleCollapse(node.id, false);
        else if (row.hasChildren) focusRow(i + 1);
        return;
      case "ArrowLeft": {
        e.preventDefault();
        if (row.hasChildren && !node.collapsed && !filter) {
          actions.toggleCollapse(node.id, true);
        } else if (node.parentId) {
          const p = indexOfRow(node.parentId);
          if (p >= 0) focusRow(p);
        }
        return;
      }
      case " ":
        e.preventDefault();
        if (row.hasChildren) actions.toggleCollapse(node.id, !node.collapsed);
        return;
      case "Enter":
        e.preventDefault();
        if (e.shiftKey && node.kind !== "tab") setRenamingId(node.id);
        else actions.primary(node.id);
        return;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        if (
          (node.kind === "tab" && node.liveTabId !== undefined) ||
          (node.kind === "window" && node.liveWindowId !== undefined)
        ) {
          actions.closeAndSave(node.id);
        } else {
          actions.deleteNode(node.id);
        }
        return;
      case "F2":
        e.preventDefault();
        if (node.kind !== "tab") setRenamingId(node.id);
        return;
      case "n":
      case "N":
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        setEditingNoteId(node.id);
        return;
      case "Escape":
        setFocusedId(null);
        return;
    }
  };

  // -- context menu ----------------------------------------------------------------------------

  const menuItems = useMemo<MenuEntry[]>(() => {
    if (!menu) return [];
    const n = tree.get(menu.id);
    if (!n) return [];
    const liveTab = n.kind === "tab" && n.liveTabId !== undefined;
    const liveWin = n.kind === "window" && n.liveWindowId !== undefined;
    const siblings = childIndex.get(n.parentId) ?? [];
    const myIndex = siblings.findIndex((s) => s.id === n.id);
    const items: MenuEntry[] = [];
    if (liveTab || liveWin)
      items.push({ label: "Focus", shortcut: "Enter", onSelect: () => actions.primary(n.id) });
    else if (n.kind === "tab" || n.kind === "window" || n.kind === "group") {
      items.push({
        label:
          n.kind === "tab"
            ? "Restore tab"
            : n.kind === "window"
              ? "Reopen window"
              : "Open all saved tabs",
        shortcut: "Enter",
        onSelect: () => actions.restore(n.id),
      });
    }
    if (liveTab || liveWin) {
      items.push({
        label: liveWin ? "Close window and save" : "Close and save",
        shortcut: "Del",
        onSelect: () => actions.closeAndSave(n.id),
      });
    }
    items.push("separator");
    items.push({
      label: n.note ? "Edit note" : "Add note",
      shortcut: "N",
      onSelect: () => setEditingNoteId(n.id),
    });
    if (n.kind !== "tab")
      items.push({ label: "Rename", shortcut: "F2", onSelect: () => setRenamingId(n.id) });
    if (n.kind !== "note") {
      items.push({ label: "New group inside", onSelect: () => actions.addGroup(n.id, 0) });
      items.push({ label: "New note inside", onSelect: () => actions.addNote(n.id, 0) });
    }
    items.push({
      label: "New group after",
      onSelect: () => actions.addGroup(n.parentId, myIndex + 1),
    });
    if (childIndex.get(n.id)?.length) {
      items.push({
        label: n.collapsed ? "Expand" : "Collapse",
        shortcut: "Space",
        onSelect: () => actions.toggleCollapse(n.id, !n.collapsed),
      });
    }
    items.push("separator");
    items.push({
      label: liveTab || liveWin ? "Delete (closes without saving)" : "Delete",
      danger: true,
      onSelect: () => actions.deleteNode(n.id),
    });
    return items;
  }, [menu, tree, childIndex, actions]);

  // -- render ---------------------------------------------------------------------------------

  const { offsets, heights, total } = layout;
  let start = 0;
  {
    let lo = 0;
    let hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((offsets[mid] ?? 0) <= scrollTop) lo = mid;
      else hi = mid - 1;
    }
    start = Math.max(0, lo - OVERSCAN);
  }
  const visible: FlatRow[] = [];
  const visibleIdx: number[] = [];
  for (let i = start; i < rows.length; i++) {
    const top = offsets[i] ?? 0;
    if (top > scrollTop + viewport + OVERSCAN * ROW) break;
    visible.push(rows[i] as FlatRow);
    visibleIdx.push(i);
  }

  return (
    <>
      <div
        ref={containerRef}
        className="tree"
        role="tree"
        tabIndex={0}
        aria-label="Windows and tabs"
        aria-activedescendant={focusedId ? `row-${focusedId}` : undefined}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
        onClick={() => setFocusedId(null)}
        onDragEnd={() => setDrag(null)}
        onDragOver={(e) => {
          // Empty space below the rows: drop at the root.
          if (!drag) return;
          if ((e.target as HTMLElement).closest(".row")) return;
          if (rootDrop(drag.id)) {
            e.preventDefault();
            setDrag((d) => (d && !d.overRoot ? { ...d, over: null, overRoot: true } : d));
          }
        }}
        onDrop={(e) => {
          if (!drag || (e.target as HTMLElement).closest(".row")) return;
          e.preventDefault();
          const dest = rootDrop(drag.id);
          setDrag(null);
          if (dest) actions.move(drag.id, dest.parentId, dest.index);
        }}
      >
        {rows.length === 0 ? (
          <div className="tree__empty">
            {query ? "Nothing matches your search." : "No windows or tabs yet."}
          </div>
        ) : (
          <div className="tree__spacer" style={{ height: total + 40 }}>
            {visible.map((row, k) => {
              const i = visibleIdx[k] ?? 0;
              const id = row.node.id;
              return (
                <TreeRow
                  key={id}
                  row={row}
                  top={offsets[i] ?? 0}
                  height={heights[i] ?? ROW}
                  focused={focusedId === id}
                  active={row.node.liveTabId !== undefined && activeTabs.has(row.node.liveTabId)}
                  editingNote={editingNoteId === id}
                  renaming={renamingId === id}
                  dragging={drag?.id === id}
                  dropPosition={drag?.over?.id === id ? drag.over.pos : null}
                  childCount={childIndex.get(id)?.length ?? 0}
                  faviconFallback={faviconFallback}
                  cb={cb}
                />
              );
            })}
            <div
              className={
                drag?.overRoot ? "tree__root-drop tree__root-drop--over" : "tree__root-drop"
              }
              style={{ top: total }}
            />
          </div>
        )}
      </div>
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      ) : null}
    </>
  );
}

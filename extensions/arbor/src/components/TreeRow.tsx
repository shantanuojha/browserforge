import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import type { ContainerAction } from "@/lib/container-actions";
import type { DropPosition, FlatRow, NodeId, TreeNode } from "@/lib/model";
import { Icon } from "./Icon";

export type { DropPosition };

export interface RowCallbacks {
  onSelect(id: NodeId): void;
  onPrimary(id: NodeId): void;
  onToggle(id: NodeId): void;
  onContextMenu(id: NodeId, x: number, y: number): void;
  onCloseAndSave(id: NodeId): void;
  onRestore(id: NodeId): void;
  onReopenAll(id: NodeId): void;
  onDelete(id: NodeId): void;
  onEditNote(id: NodeId): void;
  onSaveNote(id: NodeId, note: string): void;
  onStartRename(id: NodeId): void;
  onRename(id: NodeId, title: string): void;
  onCancelEdit(): void;
  onDragStart(id: NodeId, e: DragEvent): void;
  onDragOver(id: NodeId, e: DragEvent): void;
  onDragLeave(id: NodeId): void;
  onDrop(id: NodeId, e: DragEvent): void;
}

export interface TreeRowProps {
  row: FlatRow;
  top: number;
  height: number;
  focused: boolean;
  active: boolean;
  editingNote: boolean;
  renaming: boolean;
  dragging: boolean;
  dropPosition: DropPosition | null;
  childCount: number;
  /** Shared window/group actions (see `containerActions`); `null` for tab and note rows. */
  containerActions: ContainerAction[] | null;
  faviconFallback: ((url: string) => string) | null;
  cb: RowCallbacks;
}

const isLiveTab = (n: TreeNode) => n.kind === "tab" && n.liveTabId !== undefined;
const isLiveWindow = (n: TreeNode) => n.kind === "window" && n.liveWindowId !== undefined;

function Favicon({
  node,
  fallback,
}: {
  node: TreeNode;
  fallback: ((url: string) => string) | null;
}) {
  // Remember which source failed so a changed favicon/url gets a fresh attempt without an effect.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const candidate = node.favIconUrl || (node.url && fallback ? fallback(node.url) : undefined);
  const src = candidate && candidate !== failedSrc ? candidate : undefined;
  if (src && /^(https?:|data:|chrome-extension:|moz-extension:)/.test(src)) {
    return <img className="row__favicon" src={src} alt="" onError={() => setFailedSrc(src)} />;
  }
  return (
    <span className="row__icon">
      <Icon name="globe" size={10} />
    </span>
  );
}

function TitleEditor({
  value,
  onCommit,
  onCancel,
}: {
  value: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    const t = text.trim();
    if (t && t !== value) onCommit(t);
    else onCancel();
  };
  return (
    <input
      ref={ref}
      className="row__title-input"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onCancel();
      }}
      aria-label="Rename"
    />
  );
}

function NoteEditor({
  value,
  onCommit,
  onCancel,
}: {
  value: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const len = ref.current?.value.length ?? 0;
    ref.current?.setSelectionRange(len, len);
  }, []);
  return (
    <textarea
      ref={ref}
      className="row__note-editor"
      rows={3}
      value={text}
      placeholder="Add a note. Escape cancels; Ctrl+Enter or clicking away saves."
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onCommit(text)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          onCommit(text);
        }
      }}
      aria-label="Note"
    />
  );
}

export const TreeRow = memo(function TreeRow({
  row,
  top,
  height,
  focused,
  active,
  editingNote,
  renaming,
  dragging,
  dropPosition,
  childCount,
  containerActions,
  faviconFallback,
  cb,
}: TreeRowProps) {
  const { node, depth, hasChildren } = row;
  const live = isLiveTab(node) || isLiveWindow(node);
  const saved = (node.kind === "tab" || node.kind === "window") && !live;
  const indent = depth * 14;

  const classes = [
    "row",
    `row--${node.kind}`,
    focused && "row--focused",
    active && "row--active",
    saved && "row--saved",
    dragging && "row--dragging",
    dropPosition && `row--drop-${dropPosition}`,
    row.matched && "row--matched",
  ]
    .filter(Boolean)
    .join(" ");

  const onMainClick = (e: MouseEvent) => {
    e.stopPropagation();
    cb.onSelect(node.id);
  };
  const onDoubleClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (node.kind === "tab") cb.onPrimary(node.id);
    else if (node.kind === "window" && live) cb.onPrimary(node.id);
    else cb.onStartRename(node.id);
  };
  const onKeyDownInEditor = (e: KeyboardEvent) => e.stopPropagation();

  // Tab rows only; window and group rows get their buttons from `containerActions`.
  const canRestore = saved && !!node.url;

  return (
    <div
      className={classes}
      style={{ top, height, "--row-indent": `${indent}px` } as CSSProperties}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={hasChildren ? !node.collapsed : undefined}
      aria-selected={focused}
      id={`row-${node.id}`}
      data-id={node.id}
      draggable={!renaming && !editingNote}
      onDragStart={(e) => cb.onDragStart(node.id, e)}
      onDragOver={(e) => cb.onDragOver(node.id, e)}
      onDragLeave={() => cb.onDragLeave(node.id)}
      onDrop={(e) => cb.onDrop(node.id, e)}
      onContextMenu={(e) => {
        e.preventDefault();
        cb.onContextMenu(node.id, e.clientX, e.clientY);
      }}
    >
      <div
        className="row__main"
        style={{ paddingLeft: indent + 4 }}
        onClick={onMainClick}
        onDoubleClick={onDoubleClick}
      >
        <button
          type="button"
          className={hasChildren ? "row__twisty" : "row__twisty row__twisty--hidden"}
          tabIndex={-1}
          aria-label={node.collapsed ? "Expand" : "Collapse"}
          onClick={(e) => {
            e.stopPropagation();
            cb.onToggle(node.id);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <span
            style={{
              display: "inline-flex",
              transform: node.collapsed ? undefined : "rotate(90deg)",
            }}
          >
            <Icon name="chevron" size={10} />
          </span>
        </button>

        {node.kind === "tab" ? (
          <Favicon node={node} fallback={faviconFallback} />
        ) : (
          <span className={node.kind === "window" ? "row__icon row__icon--window" : "row__icon"}>
            <Icon
              name={node.kind === "window" ? "window" : node.kind === "group" ? "folder" : "note"}
              size={10}
            />
          </span>
        )}

        {renaming ? (
          <TitleEditor
            value={node.title}
            onCommit={(t) => cb.onRename(node.id, t)}
            onCancel={cb.onCancelEdit}
          />
        ) : (
          <span className="row__title" title={node.url ?? node.title}>
            {node.title || node.url || "Untitled"}
          </span>
        )}

        {node.note && !editingNote ? (
          <span className="row__note-flag" title="Has a note">
            <Icon name="note" size={11} />
          </span>
        ) : null}
        {node.kind === "window" || node.kind === "group" ? (
          <span className="row__meta">{childCount}</span>
        ) : null}
        {live && node.kind === "tab" ? <span className="row__live" title="Open tab" /> : null}

        <span className="row__actions" onDoubleClick={(e) => e.stopPropagation()}>
          {containerActions ? (
            // Window and group rows: one definition drives buttons and context menu alike.
            containerActions
              .filter((a) => a.inRow && !a.disabled)
              .map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={a.danger ? "icon-btn icon-btn--danger" : "icon-btn"}
                  tabIndex={-1}
                  title={a.label}
                  onClick={(e) => {
                    e.stopPropagation();
                    a.run();
                  }}
                >
                  <Icon name={a.icon} />
                </button>
              ))
          ) : (
            <>
              <button
                type="button"
                className="icon-btn"
                tabIndex={-1}
                title="Note"
                onClick={(e) => {
                  e.stopPropagation();
                  cb.onEditNote(node.id);
                }}
              >
                <Icon name="note" />
              </button>
              {live ? (
                <button
                  type="button"
                  className="icon-btn"
                  tabIndex={-1}
                  title="Close and save"
                  onClick={(e) => {
                    e.stopPropagation();
                    cb.onCloseAndSave(node.id);
                  }}
                >
                  <Icon name="close" />
                </button>
              ) : canRestore ? (
                <button
                  type="button"
                  className="icon-btn"
                  tabIndex={-1}
                  title="Restore"
                  onClick={(e) => {
                    e.stopPropagation();
                    cb.onRestore(node.id);
                  }}
                >
                  <Icon name="restore" />
                </button>
              ) : null}
              <button
                type="button"
                className="icon-btn icon-btn--danger"
                tabIndex={-1}
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  cb.onDelete(node.id);
                }}
              >
                <Icon name="trash" />
              </button>
            </>
          )}
        </span>
      </div>

      {editingNote ? (
        <div style={{ paddingLeft: indent + 26 }} onKeyDown={onKeyDownInEditor}>
          <NoteEditor
            value={node.note ?? ""}
            onCommit={(t) => cb.onSaveNote(node.id, t)}
            onCancel={cb.onCancelEdit}
          />
        </div>
      ) : node.note ? (
        <div
          className="row__note"
          style={{ marginLeft: indent + 26 }}
          title={node.note}
          onClick={(e) => {
            e.stopPropagation();
            cb.onEditNote(node.id);
          }}
        >
          {node.note}
        </div>
      ) : null}
    </div>
  );
});

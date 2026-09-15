import { memo, type CSSProperties, type DragEvent, type MouseEvent } from "react";
import { pinnedContainerAction, type ContainerAction } from "@/lib/container-actions";
import {
  DEFAULT_WINDOW_TITLE,
  displayTitle,
  isBound,
  isLiveTab,
  type DropPosition,
  type FlatRow,
  type NodeId,
  type TreeNode,
} from "@/lib/model";
import { Icon } from "./Icon";
import { TitleEditor } from "./tree-row/InlineEditors";
import { PinnedAction, RowActions } from "./tree-row/RowActions";
import { RowIcon, type FaviconFallback } from "./tree-row/RowIcon";
import { RowNote } from "./tree-row/RowNote";

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
  /** Shared container actions (see `containerActions`); `null` for tab and note rows. */
  containerActions: ContainerAction[] | null;
  faviconFallback: FaviconFallback;
  cb: RowCallbacks;
}

/** Keep in step with `--arbor-indent` in arbor.css. */
const INDENT_PER_LEVEL = 12;

interface RowFlags {
  container: boolean;
  /** Mirrors an open tab or window. */
  live: boolean;
  /** A tab or container that is closed. */
  saved: boolean;
}

function rowFlags(node: TreeNode): RowFlags {
  const container = node.kind === "window";
  const live = isLiveTab(node) || isBound(node);
  return { container, live, saved: (node.kind === "tab" || container) && !live };
}

function rowClasses(props: TreeRowProps, flags: RowFlags): string {
  const { row, focused, active, dragging, dropPosition } = props;
  return [
    "row",
    `row--${row.node.kind}`,
    focused && "row--focused",
    active && "row--active",
    flags.saved && "row--saved",
    dragging && "row--dragging",
    dropPosition && `row--drop-${dropPosition}`,
    row.matched && "row--matched",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Double-click opens tabs and open windows; anything else starts a rename. */
function primaryOrRename(node: TreeNode, flags: RowFlags, cb: RowCallbacks): void {
  if (node.kind === "tab" || (flags.container && flags.live)) cb.onPrimary(node.id);
  else cb.onStartRename(node.id);
}

interface RowTitleProps {
  node: TreeNode;
  container: boolean;
  renaming: boolean;
  cb: RowCallbacks;
}

function RowTitle({ node, container, renaming, cb }: RowTitleProps) {
  if (renaming) {
    return (
      <TitleEditor
        value={node.title}
        placeholder={container ? DEFAULT_WINDOW_TITLE : undefined}
        onCommit={(t) => cb.onRename(node.id, t)}
        onCancel={cb.onCancelEdit}
      />
    );
  }
  const title = displayTitle(node);
  return (
    <span className="row__title" title={node.url ?? title}>
      {title}
    </span>
  );
}

interface RowBadgesProps {
  node: TreeNode;
  flags: RowFlags;
  editingNote: boolean;
  childCount: number;
}

/**
 * The small marks after the title: note flag and child count. Whether a tab is open is carried
 * by the row's text colour (`row--saved`), not by a separate dot.
 */
function RowBadges({ node, flags, editingNote, childCount }: RowBadgesProps) {
  return (
    <>
      {node.note && !editingNote ? (
        <span className="row__note-flag" title="Has a note">
          <Icon name="note" size={11} />
        </span>
      ) : null}
      {flags.container ? <span className="row__meta">{childCount}</span> : null}
    </>
  );
}

/** One faint vertical line per ancestor level, aligned under that ancestor's twisty. */
function DepthGuides({ depth }: { depth: number }) {
  if (depth === 0) return null;
  return (
    <span className="row__guides" aria-hidden="true">
      {Array.from({ length: depth }, (_, level) => (
        <span
          key={level}
          className="row__guide"
          style={{ "--guide-level": level } as CSSProperties}
        />
      ))}
    </span>
  );
}

function Twisty({
  collapsed,
  visible,
  onToggle,
}: {
  collapsed: boolean;
  visible: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={visible ? "row__twisty" : "row__twisty row__twisty--hidden"}
      tabIndex={-1}
      aria-label={collapsed ? "Expand" : "Collapse"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <span style={{ display: "inline-flex", transform: collapsed ? undefined : "rotate(90deg)" }}>
        <Icon name="chevron" size={10} />
      </span>
    </button>
  );
}

export const TreeRow = memo(function TreeRow(props: TreeRowProps) {
  const { row, top, height, focused, editingNote, renaming, containerActions, cb } = props;
  const { node, depth, hasChildren } = row;
  const flags = rowFlags(node);
  const indent = depth * INDENT_PER_LEVEL;
  // A closed container keeps its Reopen button visible; the rest appear on hover/selection.
  const pinned = containerActions ? pinnedContainerAction(containerActions) : undefined;

  const onMainClick = (e: MouseEvent) => {
    e.stopPropagation();
    cb.onSelect(node.id);
  };
  const onDoubleClick = (e: MouseEvent) => {
    e.stopPropagation();
    primaryOrRename(node, flags, cb);
  };

  return (
    <div
      className={rowClasses(props, flags)}
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
      <DepthGuides depth={depth} />
      <div className="row__main" onClick={onMainClick} onDoubleClick={onDoubleClick}>
        <Twisty
          collapsed={!!node.collapsed}
          visible={hasChildren}
          onToggle={() => cb.onToggle(node.id)}
        />
        <RowIcon node={node} live={flags.live} faviconFallback={props.faviconFallback} />
        <RowTitle node={node} container={flags.container} renaming={renaming} cb={cb} />
        <RowBadges
          node={node}
          flags={flags}
          editingNote={editingNote}
          childCount={props.childCount}
        />
        {pinned ? <PinnedAction action={pinned} /> : null}
        <RowActions
          id={node.id}
          live={flags.live}
          canRestore={flags.saved && !!node.url}
          containerActions={containerActions}
          pinned={pinned}
          cb={cb}
        />
      </div>
      <RowNote
        id={node.id}
        note={node.note}
        editing={editingNote}
        onSave={cb.onSaveNote}
        onCancel={cb.onCancelEdit}
        onEdit={cb.onEditNote}
      />
    </div>
  );
});

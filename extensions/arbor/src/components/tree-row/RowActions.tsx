import type { MouseEvent } from "react";
import type { ContainerAction } from "@/lib/container-actions";
import type { NodeId } from "@/lib/model";
import { Icon, type IconName } from "../Icon";

interface ActionButtonProps {
  title: string;
  icon: IconName;
  danger?: boolean | undefined;
  onClick: () => void;
}

/** A hover button on a row; clicks never reach the row's own select / double-click handlers. */
function ActionButton({ title, icon, danger, onClick }: ActionButtonProps) {
  const stop = (e: MouseEvent) => e.stopPropagation();
  return (
    <button
      type="button"
      className={danger ? "icon-btn icon-btn--danger" : "icon-btn"}
      tabIndex={-1}
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onDoubleClick={stop}
    >
      <Icon name={icon} />
    </button>
  );
}

/** The one action that stays visible without hovering (see `pinnedContainerAction`). */
export function PinnedAction({ action }: { action: ContainerAction }) {
  return (
    <button
      type="button"
      className="icon-btn icon-btn--pinned"
      tabIndex={-1}
      title={action.label}
      aria-label={action.label}
      onClick={(e) => {
        e.stopPropagation();
        action.run();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <Icon name={action.icon} />
    </button>
  );
}

/** Window and group rows: one definition drives buttons and context menu alike. */
function ContainerButtons({
  actions,
  pinned,
}: {
  actions: ContainerAction[];
  pinned: ContainerAction | undefined;
}) {
  return (
    <>
      {actions
        .filter((a) => a.inRow && !a.disabled && a !== pinned)
        .map((a) => (
          <ActionButton
            key={a.id}
            title={a.label}
            icon={a.icon}
            danger={a.danger}
            onClick={a.run}
          />
        ))}
    </>
  );
}

export interface LeafActionHandlers {
  onEditNote(id: NodeId): void;
  onCloseAndSave(id: NodeId): void;
  onRestore(id: NodeId): void;
  onRemove(id: NodeId): void;
}

interface LeafButtonsProps {
  id: NodeId;
  live: boolean;
  canRestore: boolean;
  /** "Remove from tree" has something to do (an open tab already in place has nothing). */
  removable: boolean;
  cb: LeafActionHandlers;
}

/**
 * Tab and note rows: note, then close-and-save or restore, then remove. "Remove from tree"
 * never closes a tab; an open tab stays in the tree under its window. "Close tabs and remove"
 * is deliberately not a row button (context menu, Shift+Delete).
 */
function LeafButtons({ id, live, canRestore, removable, cb }: LeafButtonsProps) {
  return (
    <>
      <ActionButton title="Note" icon="note" onClick={() => cb.onEditNote(id)} />
      {live ? (
        <ActionButton title="Close and save" icon="close" onClick={() => cb.onCloseAndSave(id)} />
      ) : null}
      {!live && canRestore ? (
        <ActionButton title="Restore" icon="restore" onClick={() => cb.onRestore(id)} />
      ) : null}
      {removable ? (
        <ActionButton
          title={live ? "Remove from tree (tab stays open)" : "Remove from tree"}
          icon="trash"
          onClick={() => cb.onRemove(id)}
        />
      ) : null}
    </>
  );
}

export interface RowActionsProps extends LeafButtonsProps {
  /** Shared container actions (see `containerActions`); `null` for tab and note rows. */
  containerActions: ContainerAction[] | null;
  pinned: ContainerAction | undefined;
}

export function RowActions({ containerActions, pinned, ...leaf }: RowActionsProps) {
  return (
    <span className="row__actions" onDoubleClick={(e) => e.stopPropagation()}>
      {containerActions ? (
        <ContainerButtons actions={containerActions} pinned={pinned} />
      ) : (
        <LeafButtons {...leaf} />
      )}
    </span>
  );
}

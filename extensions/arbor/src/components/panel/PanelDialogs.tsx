import type { NodeId, Tree } from "@/lib/model";
import { closeAndRemoveWarning } from "@/lib/panel-text";
import { ConfirmDialog } from "../ConfirmDialog";

export type PendingConfirmation = { kind: "close-all" } | { kind: "close-and-remove"; id: NodeId };

export interface PanelDialogsProps {
  confirm: PendingConfirmation | null;
  tree: Tree;
  liveTabCount: number;
  onCloseAll(): void;
  onCloseAndRemove(id: NodeId): void;
  onCancel(): void;
}

/**
 * The two confirmations the panel asks for: closing everything, and "Close tabs and remove",
 * the one action that closes tabs without saving them. "Remove from tree" never asks: it does
 * not touch the browser and the toast offers Undo.
 */
export function PanelDialogs(props: PanelDialogsProps) {
  const { confirm, tree, liveTabCount, onCloseAll, onCloseAndRemove, onCancel } = props;
  if (confirm?.kind === "close-all") {
    return (
      <ConfirmDialog
        title="Close all open tabs?"
        confirmLabel="Close all and save"
        danger
        onConfirm={onCloseAll}
        onCancel={onCancel}
      >
        {liveTabCount} open tabs across all windows will be closed. Every one of them stays in the
        tree as a saved node and can be restored later. A blank tab is kept open so the browser does
        not quit.
      </ConfirmDialog>
    );
  }
  if (confirm?.kind === "close-and-remove") {
    return (
      <ConfirmDialog
        title="Close tabs and remove from the tree?"
        confirmLabel="Close tabs and remove"
        danger
        onConfirm={() => onCloseAndRemove(confirm.id)}
        onCancel={onCancel}
      >
        {closeAndRemoveWarning(tree, confirm.id)}
      </ConfirmDialog>
    );
  }
  return null;
}

import type { NodeId, Tree } from "@/lib/model";
import { deleteWarning } from "@/lib/panel-text";
import { ConfirmDialog } from "../ConfirmDialog";

export type PendingConfirmation = { kind: "close-all" } | { kind: "delete"; id: NodeId };

export interface PanelDialogsProps {
  confirm: PendingConfirmation | null;
  tree: Tree;
  liveTabCount: number;
  onCloseAll(): void;
  onDelete(id: NodeId): void;
  onCancel(): void;
}

/** The two confirmations the panel asks for: closing everything, and deletes that lose tabs. */
export function PanelDialogs(props: PanelDialogsProps) {
  const { confirm, tree, liveTabCount, onCloseAll, onDelete, onCancel } = props;
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
  if (confirm?.kind === "delete") {
    return (
      <ConfirmDialog
        title="Delete from the tree?"
        confirmLabel="Delete"
        danger
        onConfirm={() => onDelete(confirm.id)}
        onCancel={onCancel}
      >
        {deleteWarning(tree, confirm.id)}
      </ConfirmDialog>
    );
  }
  return null;
}

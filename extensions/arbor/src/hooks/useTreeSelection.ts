import { useMemo, useState } from "react";
import type { NodeId, Tree } from "@/lib/model";

export interface SelectionIds {
  /** The row keyboard commands act on; `null` when nothing is selected. */
  focusedId: NodeId | null;
  editingNoteId: NodeId | null;
  renamingId: NodeId | null;
}

/** Stable for the lifetime of the component, so callbacks can depend on it. */
export interface SelectionApi {
  setFocusedId(id: NodeId | null): void;
  setEditingNoteId(id: NodeId | null): void;
  setRenamingId(id: NodeId | null): void;
  /** Open the note editor on `id` (and close a rename in progress). */
  startEditingNote(id: NodeId): void;
  /** Open the title editor on `id` (and close a note editor in progress). */
  startRenaming(id: NodeId): void;
  /** Close whichever inline editor is open. */
  stopEditing(): void;
}

export interface TreeSelection {
  ids: SelectionIds;
  api: SelectionApi;
}

/**
 * Which row is selected and which inline editor is open. Ids are only meaningful while the node
 * exists, so they are derived against the current tree instead of synced with an effect.
 */
export function useTreeSelection(tree: Tree): TreeSelection {
  const [rawFocusedId, setFocusedId] = useState<NodeId | null>(null);
  const [rawEditingNoteId, setEditingNoteId] = useState<NodeId | null>(null);
  const [rawRenamingId, setRenamingId] = useState<NodeId | null>(null);
  const existing = (id: NodeId | null) => (id && tree.has(id) ? id : null);
  const api = useMemo<SelectionApi>(
    () => ({
      setFocusedId,
      setEditingNoteId,
      setRenamingId,
      startEditingNote(id) {
        setRenamingId(null);
        setEditingNoteId(id);
        setFocusedId(id);
      },
      startRenaming(id) {
        setEditingNoteId(null);
        setRenamingId(id);
      },
      stopEditing() {
        setRenamingId(null);
        setEditingNoteId(null);
      },
    }),
    [],
  );
  return {
    ids: {
      focusedId: existing(rawFocusedId),
      editingNoteId: existing(rawEditingNoteId),
      renamingId: existing(rawRenamingId),
    },
    api,
  };
}

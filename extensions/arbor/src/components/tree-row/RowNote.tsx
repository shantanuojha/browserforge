import type { KeyboardEvent } from "react";
import type { NodeId } from "@/lib/model";
import { NoteEditor } from "./InlineEditors";

export interface RowNoteProps {
  id: NodeId;
  note: string | undefined;
  editing: boolean;
  indent: number;
  onSave(id: NodeId, note: string): void;
  onCancel(): void;
  onEdit(id: NodeId): void;
}

/** The second line of a row: the note editor while editing, else the note preview, else nothing. */
export function RowNote({ id, note, editing, indent, onSave, onCancel, onEdit }: RowNoteProps) {
  const onKeyDownInEditor = (e: KeyboardEvent) => e.stopPropagation();
  if (editing) {
    return (
      <div style={{ paddingLeft: indent + 26 }} onKeyDown={onKeyDownInEditor}>
        <NoteEditor value={note ?? ""} onCommit={(t) => onSave(id, t)} onCancel={onCancel} />
      </div>
    );
  }
  if (!note) return null;
  return (
    <div
      className="row__note"
      style={{ marginLeft: indent + 26 }}
      title={note}
      onClick={(e) => {
        e.stopPropagation();
        onEdit(id);
      }}
    >
      {note}
    </div>
  );
}

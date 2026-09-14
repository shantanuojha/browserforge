import { useEffect, useRef, useState } from "react";

/**
 * An inline editor finishes exactly once. Its `onCommit` / `onCancel` handlers move focus back
 * to the tree while the editor is still mounted, which blurs it and would otherwise run the blur
 * commit a second time: Enter committed twice (two history entries) and Escape committed the
 * text it was meant to discard.
 */
function useFinishOnce(): (fn: () => void) => void {
  const done = useRef(false);
  return (fn) => {
    if (done.current) return;
    done.current = true;
    fn();
  };
}

export interface TitleEditorProps {
  value: string;
  placeholder?: string | undefined;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

export function TitleEditor({ value, placeholder, onCommit, onCancel }: TitleEditorProps) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const finish = useFinishOnce();
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () =>
    finish(() => {
      const t = text.trim();
      if (t && t !== value) onCommit(t);
      else onCancel();
    });
  const cancel = () => finish(onCancel);
  return (
    <input
      ref={ref}
      className="row__title-input"
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") cancel();
      }}
      aria-label="Rename"
    />
  );
}

export interface NoteEditorProps {
  value: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

export function NoteEditor({ value, onCommit, onCancel }: NoteEditorProps) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  const finish = useFinishOnce();
  useEffect(() => {
    ref.current?.focus();
    const len = ref.current?.value.length ?? 0;
    ref.current?.setSelectionRange(len, len);
  }, []);
  const commit = () => finish(() => onCommit(text));
  const cancel = () => finish(onCancel);
  return (
    <textarea
      ref={ref}
      className="row__note-editor"
      rows={3}
      value={text}
      placeholder="Add a note. Escape cancels; Ctrl+Enter or clicking away saves."
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          commit();
        }
      }}
      aria-label="Note"
    />
  );
}

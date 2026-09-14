import { useEffect } from "react";

export interface PanelShortcutHandlers {
  focusSearch(): void;
  undo(): void;
  redo(): void;
}

const inTextField = (target: EventTarget | null): boolean => {
  const tag = (target as HTMLElement | null)?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA";
};

/**
 * "/" focuses search from anywhere in the panel; Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y undo and redo
 * tree edits while the panel has focus (inside a text field they keep their native meaning).
 */
export function usePanelShortcuts({ focusSearch, undo, redo }: PanelShortcutHandlers): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (inTextField(e.target)) return;
      if (e.key === "/") {
        e.preventDefault();
        focusSearch();
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (key === "y" && !e.shiftKey) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusSearch, undo, redo]);
}

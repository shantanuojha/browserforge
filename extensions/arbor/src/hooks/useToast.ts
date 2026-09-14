import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "@browserforge/shared";

/** Footer message; `undo` adds an Undo button for the entry just recorded. */
export interface Toast {
  text: string;
  undo?: boolean;
}

const TOAST_MS = 4000;
/** A toast that offers Undo stays a little longer. */
const UNDO_TOAST_MS = 5000;

export interface ToastApi {
  toast: Toast | null;
  show(toast: Toast | null): void;
  /** Show an error as a toast; the shape every `.catch` in the panel wants. */
  report(error: unknown): void;
}

export function useToast(): ToastApi {
  const [toast, show] = useState<Toast | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => show(null), toast.undo ? UNDO_TOAST_MS : TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);
  const report = useCallback((error: unknown) => show({ text: errorMessage(error) }), []);
  return { toast, show, report };
}

import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import { focusableElements, nextFocusTarget } from "./focusTrap.js";

export interface ModalFocus {
  dialogRef: RefObject<HTMLDivElement | null>;
  /** Attach to the dialog element: Escape closes, Tab stays inside. */
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
}

/**
 * Modal focus management: moves focus into the dialog on open (unless something inside, e.g. an
 * autofocused input, already has it), traps Tab, closes on Escape and hands focus back to the
 * opener on unmount.
 */
export function useModalFocus(onClose: () => void): ModalFocus {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.contains(document.activeElement)) {
      (focusableElements(dialog)[0] ?? dialog).focus();
    }
    return () => opener?.focus();
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const target = nextFocusTarget(
      focusableElements(dialogRef.current),
      document.activeElement,
      event.shiftKey,
    );
    if (target) {
      event.preventDefault();
      target.focus();
    }
  }

  return { dialogRef, onKeyDown };
}

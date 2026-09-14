/**
 * Minimal focus management for modal dialogs (no dependency, no portal assumptions).
 *
 * `nextFocusTarget` is pure so the wrap-around rules can be unit-tested without a DOM;
 * `focusableElements` is the only DOM-touching part.
 */

/** Controls a user can reach with Tab. Disabled controls and `tabindex="-1"` are skipped. */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function focusableElements(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.tabIndex >= 0 && !el.hasAttribute("aria-hidden"),
  );
}

/**
 * Where Tab (or Shift+Tab when `backwards`) must move focus so it stays inside `elements`
 * (in DOM order). Returns `null` when the browser's default move already stays inside, so
 * the caller only intervenes at the edges or when focus is outside / on the container.
 */
export function nextFocusTarget<T>(
  elements: readonly T[],
  active: unknown,
  backwards: boolean,
): T | null {
  if (elements.length === 0) return null;
  const first = elements[0] as T;
  const last = elements[elements.length - 1] as T;
  const index = active == null ? -1 : elements.indexOf(active as T);
  if (index === -1) return backwards ? last : first;
  if (!backwards && index === elements.length - 1) return first;
  if (backwards && index === 0) return last;
  return null;
}

import type { ReactNode } from "react";

/** Joins truthy class names; keeps component files free of `.filter(Boolean).join(" ")` noise. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** True when an optional slot has something to render (`undefined`, `null` and `false` do not). */
export function isRenderable(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false;
}

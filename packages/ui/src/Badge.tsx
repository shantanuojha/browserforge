import type { ReactNode } from "react";
import { cx } from "./classNames.js";

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger" | "pro";

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  title?: string;
  className?: string;
}

/** Small inline status label. Use `ProBadge` for the Pro marker specifically. */
export function Badge({ tone = "neutral", children, title, className }: BadgeProps) {
  return (
    <span className={cx("bf-badge", `bf-badge--${tone}`, className)} title={title}>
      {children}
    </span>
  );
}

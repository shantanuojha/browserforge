import type { ReactNode } from "react";
import { cx } from "./classNames.js";

export type CalloutTone = "info" | "success" | "warning" | "danger";

export interface CalloutProps {
  tone?: CalloutTone;
  title?: ReactNode;
  children?: ReactNode;
  /** Optional trailing action, e.g. a small Button. */
  action?: ReactNode;
  className?: string;
}

/** Inline message block. Warnings and errors are announced as alerts; the rest as status. */
export function Callout({ tone = "info", title, children, action, className }: CalloutProps) {
  const role = tone === "danger" || tone === "warning" ? "alert" : "status";
  return (
    <div className={cx("bf-callout", `bf-callout--${tone}`, className)} role={role}>
      <div className="bf-callout__body">
        {title ? <p className="bf-callout__title">{title}</p> : null}
        {children ? <div className="bf-callout__text">{children}</div> : null}
      </div>
      {action ? <div className="bf-callout__action">{action}</div> : null}
    </div>
  );
}

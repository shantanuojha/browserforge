import type { ReactNode } from "react";
import { cx } from "./classNames.js";

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  /** Decorative illustration/icon; hidden from assistive tech. */
  icon?: ReactNode;
  /** Primary call to action, usually a Button. */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <div className={cx("bf-empty", className)}>
      {icon ? (
        <div className="bf-empty__icon" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <p className="bf-empty__title">{title}</p>
      {description ? <p className="bf-empty__description">{description}</p> : null}
      {action ? <div className="bf-empty__action">{action}</div> : null}
    </div>
  );
}

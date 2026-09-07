import type { ReactNode } from "react";

export interface PanelProps {
  title: ReactNode;
  /** Rendered on the right side of the header (e.g. a ProBadge or actions). */
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function Panel({ title, actions, children, className }: PanelProps) {
  const classes = ["bf-panel", className].filter(Boolean).join(" ");
  return (
    <section className={classes}>
      <header className="bf-panel__header">
        <h1 className="bf-panel__title">{title}</h1>
        {actions ? <div className="bf-panel__actions">{actions}</div> : null}
      </header>
      <div className="bf-panel__body">{children}</div>
    </section>
  );
}

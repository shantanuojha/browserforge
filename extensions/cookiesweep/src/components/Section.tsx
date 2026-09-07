import type { ReactNode } from "react";

export interface SectionProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}

export function Section({ title, description, actions, children }: SectionProps) {
  return (
    <section className="cs-section">
      <header className="cs-section__header">
        <div>
          <h2 className="cs-section__title">{title}</h2>
          {description ? <p className="cs-section__desc">{description}</p> : null}
        </div>
        {actions ? <div className="cs-row">{actions}</div> : null}
      </header>
      <div className="cs-section__body">{children}</div>
    </section>
  );
}

import { useId, type ReactNode } from "react";
import { cx } from "./classNames.js";

export interface SectionProps {
  title: ReactNode;
  description?: ReactNode;
  /** Rendered to the right of the title (badge, small action). */
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  id?: string;
}

/** Labelled group of settings or content inside a Panel or options page. */
export function Section({ title, description, actions, children, className, id }: SectionProps) {
  const autoId = useId();
  const sectionId = id ?? `bf-section-${autoId}`;
  const titleId = `${sectionId}-title`;
  const descriptionId = `${sectionId}-description`;

  return (
    <section
      id={sectionId}
      className={cx("bf-section", className)}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
    >
      <header className="bf-section__header">
        <div className="bf-section__heading">
          <h2 className="bf-section__title" id={titleId}>
            {title}
          </h2>
          {description ? (
            <p className="bf-section__description" id={descriptionId}>
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className="bf-section__actions">{actions}</div> : null}
      </header>
      {children !== undefined && children !== null ? (
        <div className="bf-section__body">{children}</div>
      ) : null}
    </section>
  );
}

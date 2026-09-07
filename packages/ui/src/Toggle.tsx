import { useId, type ReactNode } from "react";
import { cx } from "./classNames.js";

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/** Accessible switch: a `role="switch"` button with a clickable label and optional description. */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
  id,
  className,
}: ToggleProps) {
  const autoId = useId();
  const controlId = id ?? `bf-toggle-${autoId}`;
  const labelId = `${controlId}-label`;
  const descriptionId = `${controlId}-description`;

  return (
    <div
      className={cx(
        "bf-toggle",
        checked && "bf-toggle--on",
        disabled && "bf-toggle--disabled",
        className,
      )}
    >
      <label className="bf-toggle__text" htmlFor={controlId}>
        <span className="bf-toggle__label" id={labelId}>
          {label}
        </span>
        {description ? (
          <span className="bf-toggle__description" id={descriptionId}>
            {description}
          </span>
        ) : null}
      </label>
      <button
        type="button"
        role="switch"
        id={controlId}
        className="bf-toggle__control"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={description ? descriptionId : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="bf-toggle__thumb" aria-hidden="true" />
      </button>
    </div>
  );
}

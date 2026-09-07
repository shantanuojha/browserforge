import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import { cx } from "./classNames.js";

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: ReactNode;
  /** Visually hide the label (it stays available to screen readers). */
  hideLabel?: boolean;
  hint?: ReactNode;
  /** Error message; sets `aria-invalid` and is announced via `aria-describedby`. */
  error?: ReactNode;
  id?: string;
  /** Use the monospace font (licence keys, URLs, patterns). */
  mono?: boolean;
}

export function TextInput({
  label,
  hideLabel,
  hint,
  error,
  id,
  mono,
  className,
  type = "text",
  ...rest
}: TextInputProps) {
  const autoId = useId();
  const inputId = id ?? `bf-input-${autoId}`;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const hasHint = hint !== undefined && hint !== null && hint !== false;
  const hasError = error !== undefined && error !== null && error !== false;
  const describedBy = cx(hasHint && hintId, hasError && errorId) || undefined;

  return (
    <div className={cx("bf-field", hasError && "bf-field--invalid", className)}>
      <label className={cx("bf-field__label", hideLabel && "bf-visually-hidden")} htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        type={type}
        className={cx("bf-input", mono && "bf-input--mono")}
        aria-invalid={hasError ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {hasHint ? (
        <p className="bf-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {hasError ? (
        <p className="bf-field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

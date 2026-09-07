import { useId, type ReactNode, type SelectHTMLAttributes } from "react";
import { cx } from "./classNames.js";

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<V extends string = string> extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "id" | "onChange" | "value" | "children"
> {
  label: ReactNode;
  hideLabel?: boolean;
  options: readonly SelectOption<V>[];
  value: V;
  onChange: (value: V) => void;
  hint?: ReactNode;
  id?: string;
}

/** Native `<select>` with a real label; native pickers are the most accessible in a popup. */
export function Select<V extends string = string>({
  label,
  hideLabel,
  options,
  value,
  onChange,
  hint,
  id,
  className,
  ...rest
}: SelectProps<V>) {
  const autoId = useId();
  const selectId = id ?? `bf-select-${autoId}`;
  const hintId = `${selectId}-hint`;

  return (
    <div className={cx("bf-field", className)}>
      <label
        className={cx("bf-field__label", hideLabel && "bf-visually-hidden")}
        htmlFor={selectId}
      >
        {label}
      </label>
      <div className="bf-select">
        <select
          id={selectId}
          className="bf-select__control"
          value={value}
          onChange={(event) => onChange(event.currentTarget.value as V)}
          aria-describedby={hint ? hintId : undefined}
          {...rest}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {hint ? (
        <p className="bf-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

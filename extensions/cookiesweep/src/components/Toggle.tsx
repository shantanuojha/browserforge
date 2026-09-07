import { useId, type ReactNode } from "react";

export interface ToggleProps {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

export function Toggle({ label, hint, checked, disabled, onChange }: ToggleProps) {
  const id = useId();
  return (
    <div className="cs-field">
      <div>
        <label id={id} className="cs-field__label" htmlFor={`${id}-switch`}>
          {label}
        </label>
        {hint ? <p className="cs-field__hint">{hint}</p> : null}
      </div>
      <button
        id={`${id}-switch`}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        className="cs-toggle"
        disabled={disabled}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

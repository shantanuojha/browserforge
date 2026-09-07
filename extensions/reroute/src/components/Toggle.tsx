import type { ReactNode } from "react";

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  title?: string;
}

export function Toggle({ checked, onChange, label, disabled, title }: ToggleProps) {
  return (
    <label className="rr-toggle" title={title}>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="rr-toggle__track" aria-hidden="true" />
      {label ? <span>{label}</span> : null}
    </label>
  );
}

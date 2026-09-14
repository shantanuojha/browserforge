import { useState, type ReactNode } from "react";

export interface FieldProps {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}

export function Field({ label, hint, htmlFor, children }: FieldProps) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        <span>{label}</span>
        {hint ? <span className="field__hint">{hint}</span> : null}
      </label>
      {children}
    </div>
  );
}

export interface NumberFieldProps {
  id: string;
  min: number;
  max: number;
  value: number;
  disabled?: boolean | undefined;
  onCommit: (value: number) => void;
}

/**
 * A number input whose stored value is clamped. While it has focus it shows what the user typed
 * and only commits values inside the range; the clamped value is committed on blur. Committing
 * every keystroke straight into the clamped setting snapped the field mid-edit (clearing the
 * snapshot interval showed "1", typing "10" then produced "110").
 */
export function NumberField({ id, min, max, value, disabled, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)));
  const parse = (text: string): number | null => {
    if (text.trim() === "") return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  };
  return (
    <input
      id={id}
      type="number"
      min={min}
      max={max}
      disabled={disabled}
      value={draft ?? String(value)}
      onFocus={() => setDraft(String(value))}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = parse(e.target.value);
        if (n !== null && n >= min && n <= max && Number.isInteger(n)) onCommit(n);
      }}
      onBlur={() => {
        const n = draft === null ? null : parse(draft);
        setDraft(null);
        if (n !== null && clamp(n) !== value) onCommit(clamp(n));
      }}
    />
  );
}

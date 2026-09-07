import { useState, type ReactNode } from "react";
import { Button, type ButtonProps } from "@browserforge/ui";

export interface ConfirmButtonProps {
  label: ReactNode;
  confirmLabel?: ReactNode;
  prompt?: ReactNode;
  busy?: boolean;
  disabled?: boolean;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  onConfirm: () => void | Promise<void>;
}

/** Two-step button: first click arms it, second click confirms. Escape or Cancel disarms. */
export function ConfirmButton({
  label,
  confirmLabel = "Confirm",
  prompt = "Are you sure?",
  busy,
  disabled,
  variant = "secondary",
  size = "md",
  className,
  onConfirm,
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <Button
        variant={variant}
        size={size}
        className={className}
        disabled={disabled || busy}
        onClick={() => setArmed(true)}
      >
        {busy ? "Working..." : label}
      </Button>
    );
  }
  return (
    <div className="cs-row" role="group" aria-label="Confirm action">
      <span className="cs-small">{prompt}</span>
      <Button
        variant="primary"
        size={size}
        className={className}
        disabled={busy}
        onClick={async () => {
          setArmed(false);
          await onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
      <Button variant="ghost" size={size} onClick={() => setArmed(false)}>
        Cancel
      </Button>
    </div>
  );
}

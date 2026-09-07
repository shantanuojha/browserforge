import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./classNames.js";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Accessible name; icon-only buttons must always have one. Also used as the tooltip. */
  label: string;
  /** The icon (inline SVG or text glyph). Hidden from assistive tech. */
  children: ReactNode;
  variant?: "secondary" | "ghost";
  size?: "sm" | "md";
}

export function IconButton({
  label,
  children,
  variant = "ghost",
  size = "md",
  className,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        "bf-icon-button",
        `bf-icon-button--${variant}`,
        `bf-icon-button--${size}`,
        className,
      )}
      aria-label={label}
      title={label}
      {...rest}
    >
      <span className="bf-icon-button__icon" aria-hidden="true">
        {children}
      </span>
    </button>
  );
}

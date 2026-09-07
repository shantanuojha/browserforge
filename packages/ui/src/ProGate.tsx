import type { ReactNode } from "react";
import { Button } from "./Button.js";
import { ProBadge } from "./ProBadge.js";
import { cx } from "./classNames.js";

export interface ProGateProps<F extends string = string> {
  feature: F;
  /** Usually `features.can` from `defineFeatures()` in `@browserforge/licensing`. */
  can: (feature: F) => boolean;
  /** Display price, e.g. "$9 one-time". */
  price: string;
  /** Hosted Lemon Squeezy checkout URL supplied by the extension. Opened in a new tab. */
  checkoutUrl: string;
  /** Short human label for the locked feature; defaults to the feature id. */
  featureLabel?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Opens a URL in a new tab without handing the opener to the target page. */
export function openExternal(url: string): void {
  if (typeof window === "undefined") return;
  window.open(url, "_blank", "noopener");
}

/**
 * Renders `children` when `can(feature)` is true; otherwise a compact upsell row.
 * Never embeds remote scripts: the checkout is a plain link opened in a new tab.
 */
export function ProGate<F extends string = string>({
  feature,
  can,
  price,
  checkoutUrl,
  featureLabel,
  children,
  className,
}: ProGateProps<F>) {
  if (can(feature)) return <>{children}</>;

  return (
    <div className={cx("bf-pro-gate", className)} data-feature={feature}>
      <div className="bf-pro-gate__text">
        <span className="bf-pro-gate__title">
          <ProBadge title="Requires Pro" /> {featureLabel ?? feature}
        </span>
        <span className="bf-pro-gate__price">{price}</span>
      </div>
      <Button
        size="sm"
        onClick={() => openExternal(checkoutUrl)}
        aria-label={`Unlock Pro, ${price}`}
      >
        Unlock
      </Button>
    </div>
  );
}

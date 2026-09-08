import { Button, ProBadge } from "@browserforge/ui";
import { openCheckout, PRO_PRICE_TEXT } from "@/lib/licensing";

export interface UpsellRowProps {
  /** What the user would unlock, e.g. "Scheduled backups". */
  feature: string;
  compact?: boolean;
}

/** Opens the hosted checkout (or the product page when no checkout is configured) in a new tab. */
export function openProPage(): void {
  openCheckout();
}

export function UpsellRow({ feature, compact = false }: UpsellRowProps) {
  return (
    <div className={compact ? "upsell upsell--compact" : "upsell"} role="note">
      <ProBadge title="Pro feature" />
      <span className="upsell__text">
        {feature} <span className="upsell__price">{PRO_PRICE_TEXT}</span>
      </span>
      <Button size="sm" variant={compact ? "ghost" : "primary"} onClick={openProPage}>
        Get Pro
      </Button>
    </div>
  );
}

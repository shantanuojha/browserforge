import { Button, ProBadge } from "@browserforge/ui";
import { LICENSING, openCheckout, PRO_PRICE_TEXT } from "@/lib/licensing";

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
  // Without a configured store nothing can be bought yet, so do not quote a price or say "Get".
  const purchasable = LICENSING.configured;
  return (
    <div className={compact ? "upsell upsell--compact" : "upsell"} role="note">
      <ProBadge title="Pro feature" />
      <span className="upsell__text">
        {feature}{" "}
        <span className="upsell__price">
          {purchasable ? PRO_PRICE_TEXT : "Pro \u2014 opening soon"}
        </span>
      </span>
      <Button size="sm" variant={compact ? "ghost" : "primary"} onClick={openProPage}>
        {purchasable ? "Get Pro" : "About Pro"}
      </Button>
    </div>
  );
}

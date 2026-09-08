import { Button } from "@browserforge/ui";
import { LICENSING, openCheckout } from "../lib/licensing";
import { PRO_UPSELL_LABEL } from "../lib/pro";

export interface UpsellRowProps {
  feature?: string;
}

/** Opens the hosted checkout (or the product page when no checkout is configured) in a new tab. */
export function openProPage(): void {
  openCheckout();
}

export function UpsellRow({ feature }: UpsellRowProps) {
  // Without a configured store nothing can be bought yet, so do not quote a price or say "Get".
  const purchasable = LICENSING.configured;
  return (
    <div className="rr-upsell" role="note">
      <div>
        <div className="rr-upsell__title">
          {purchasable ? PRO_UPSELL_LABEL : "Pro \u2014 opening soon"}
        </div>
        <div className="rr-small">
          {feature
            ? `${feature} is a Pro feature. Unlock sync, rule packs and shareable links.`
            : "Unlock rule sync, curated rule packs and shareable rule links."}
        </div>
      </div>
      <Button variant="primary" size="sm" onClick={openProPage}>
        {purchasable ? "Get Pro" : "About Pro"}
      </Button>
    </div>
  );
}

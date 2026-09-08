import { Button } from "@browserforge/ui";
import { openCheckout } from "../lib/licensing";
import { PRO_UPSELL_LABEL } from "../lib/pro";

export interface UpsellRowProps {
  feature?: string;
}

/** Opens the hosted checkout (or the product page when no checkout is configured) in a new tab. */
export function openProPage(): void {
  openCheckout();
}

export function UpsellRow({ feature }: UpsellRowProps) {
  return (
    <div className="rr-upsell" role="note">
      <div>
        <div className="rr-upsell__title">{PRO_UPSELL_LABEL}</div>
        <div className="rr-small">
          {feature
            ? `${feature} is a Pro feature. Unlock sync, rule packs and shareable links.`
            : "Unlock rule sync, curated rule packs and shareable rule links."}
        </div>
      </div>
      <Button variant="primary" size="sm" onClick={openProPage}>
        Get Pro
      </Button>
    </div>
  );
}

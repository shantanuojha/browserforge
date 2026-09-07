import { Button } from "@browserforge/ui";
import { browser } from "wxt/browser";
import { PRO_UPSELL_LABEL, PRO_URL } from "../lib/pro";

export interface UpsellRowProps {
  feature?: string;
}

export function openProPage(): void {
  void browser.tabs.create({ url: PRO_URL });
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

import { Button, ProBadge } from "@browserforge/ui";
import { browser } from "wxt/browser";
import { PRO_PRICE_TEXT, PRO_URL } from "@/lib/pro";

export interface UpsellRowProps {
  /** What the user would unlock, e.g. "Scheduled backups". */
  feature: string;
  compact?: boolean;
}

export function openProPage(): void {
  void browser.tabs.create({ url: PRO_URL });
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

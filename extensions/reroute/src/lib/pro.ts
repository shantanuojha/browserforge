/**
 * What Pro is, in words: the feature list and the upsell copy. The licence itself is handled by
 * `@browserforge/licensing` through `adapters/licensing.ts`.
 */

import { PRO_PAGE_URL, PRO_PRICE_TEXT } from "./licensing-config";

export type ProFeature = "sync" | "rule-packs" | "share";

export const PRO_FEATURES: Record<ProFeature, { title: string; description: string }> = {
  sync: {
    title: "Sync rules across devices",
    description: "Mirror your rules through browser sync storage, chunked to fit its quota.",
  },
  "rule-packs": {
    title: "Curated rule packs",
    description: "One-click installs such as Old Reddit, privacy front-ends and AMP to canonical.",
  },
  share: {
    title: "Shareable rule links",
    description: "Export a rule set as a reroute:// link that anyone can paste into Reroute.",
  },
};

export const PRO_UPSELL_LABEL = PRO_PRICE_TEXT;
export const PRO_URL = PRO_PAGE_URL;

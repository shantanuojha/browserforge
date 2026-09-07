/**
 * Pro gating. `@browserforge/licensing` currently exposes only
 * `getEntitlements()`; everything else about Pro (features, copy, URL) lives here.
 */

import { getEntitlements } from "@browserforge/licensing";

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

export const PRO_UPSELL_LABEL = "Pro \u2014 $9 one-time";
export const PRO_URL = "https://browserforge.dev/reroute#pro";

export async function isPro(): Promise<boolean> {
  try {
    const ent = await getEntitlements();
    return ent.pro === true;
  } catch {
    return false;
  }
}

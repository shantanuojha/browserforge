import type { ListType } from "../lib/settings.js";

export type SiteStatus = ListType | "clean" | "paused" | "none";

const LABELS: Record<SiteStatus, string> = {
  white: "Protected",
  grey: "Greylisted",
  clean: "Will be cleaned",
  paused: "Paused",
  none: "Not a web page",
};

const CLASSES: Record<SiteStatus, string> = {
  white: "cs-pill cs-pill--white",
  grey: "cs-pill cs-pill--grey",
  clean: "cs-pill cs-pill--clean",
  paused: "cs-pill cs-pill--paused",
  none: "cs-pill",
};

export function StatusPill({ status, label }: { status: SiteStatus; label?: string }) {
  return <span className={CLASSES[status]}>{label ?? LABELS[status]}</span>;
}

export function listTypeLabel(type: ListType): string {
  return type === "white" ? "Whitelist" : "Greylist";
}

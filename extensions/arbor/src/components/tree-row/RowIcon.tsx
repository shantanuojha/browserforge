import { useState } from "react";
import type { TreeNode } from "@/lib/model";
import { ContainerIcon, Icon } from "../Icon";

export type FaviconFallback = ((url: string) => string) | null;

const SAFE_ICON_SRC = /^(https?:|data:|chrome-extension:|moz-extension:)/;

function Favicon({ node, fallback }: { node: TreeNode; fallback: FaviconFallback }) {
  // Remember which source failed so a changed favicon/url gets a fresh attempt without an effect.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const candidate = node.favIconUrl || (node.url && fallback ? fallback(node.url) : undefined);
  const src = candidate && candidate !== failedSrc ? candidate : undefined;
  if (src && SAFE_ICON_SRC.test(src)) {
    return <img className="row__favicon" src={src} alt="" onError={() => setFailedSrc(src)} />;
  }
  return (
    <span className="row__icon">
      <Icon name="globe" size={10} />
    </span>
  );
}

export interface RowIconProps {
  node: TreeNode;
  /** The node mirrors an open tab or window. */
  live: boolean;
  faviconFallback: FaviconFallback;
}

/** The leading icon of a row: a tab's favicon, a container's frame, or the note glyph. */
export function RowIcon({ node, live, faviconFallback }: RowIconProps) {
  if (node.kind === "tab") return <Favicon node={node} fallback={faviconFallback} />;
  if (node.kind === "window") {
    // Windows and groups are one thing: the same frame, filled while its window is open.
    return (
      <span className={live ? "row__icon row__icon--open" : "row__icon row__icon--closed"}>
        <ContainerIcon
          open={live}
          size={10}
          title={live ? "Open window" : "Closed window (group)"}
        />
      </span>
    );
  }
  return (
    <span className="row__icon">
      <Icon name="note" size={10} />
    </span>
  );
}

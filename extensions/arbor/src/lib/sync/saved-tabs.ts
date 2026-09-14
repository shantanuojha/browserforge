/** Matching a container's saved tabs to the browser tabs a reopen produced. */
import { containerTabs, type NodeId, type Tree, type TreeNode } from "../model";
import { sameUrl } from "./url";

export interface SavedTabClaim {
  /** Nodes already matched in this round; a hit is added by the caller. */
  used: Set<NodeId>;
  /** Restrict matches to these nodes (undo of a partial close). */
  only?: ReadonlySet<NodeId> | undefined;
}

/** First unused closed tab of a container (nested containers excluded) with this url. */
export function savedTabByUrl(
  tree: Tree,
  containerId: NodeId,
  url: string,
  claim: SavedTabClaim,
): TreeNode | undefined {
  for (const n of containerTabs(tree, containerId)) {
    if (
      n.liveTabId === undefined &&
      !claim.used.has(n.id) &&
      (!claim.only || claim.only.has(n.id)) &&
      sameUrl(n.url, url)
    ) {
      return n;
    }
  }
  return undefined;
}

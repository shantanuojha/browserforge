/** Rules for nodes arriving through "Import": they enter the tree as saved nodes. */
import type { TreeNode } from "../model";

/** Copies of `nodes` without live ids; the rebuild that follows re-links open tabs by URL. */
export function asSavedNodes(nodes: readonly TreeNode[]): TreeNode[] {
  return nodes.map((n) => {
    const copy = { ...n };
    delete copy.liveTabId;
    delete copy.liveWindowId;
    return copy;
  });
}

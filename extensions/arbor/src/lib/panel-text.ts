/** Copy the side panel composes from the tree. Pure. */
import { displayTitle, type NodeId, type Tree } from "./model";
import { plural, summarizeRemoval } from "./removal";

export { plural };

/**
 * Body of the "Close tabs and remove" confirmation: how many open tabs close unsaved, and that
 * the node and its saved items are deleted from the tree.
 */
export function closeAndRemoveWarning(tree: Tree, id: NodeId): string {
  const node = tree.get(id);
  if (!node) return "";
  const s = summarizeRemoval(tree, node);
  const saved = s.removed - (s.stays ? 0 : 1);
  const closes = `${plural(s.liveTabs, "open tab")} will be closed without being saved`;
  const deletes = `"${displayTitle(node)}"${saved ? ` with its ${plural(saved, "saved item")}` : ""} will be deleted from the tree`;
  return `${closes}, and ${deletes}. Earlier snapshots in Recovery still contain them.`;
}

export function liveTabCount(tree: Tree): number {
  let n = 0;
  for (const node of tree.values()) if (node.kind === "tab" && node.liveTabId !== undefined) n++;
  return n;
}

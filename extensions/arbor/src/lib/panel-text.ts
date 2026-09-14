/** Copy the side panel composes from the tree. Pure. */
import { summarizeContainer } from "./container-actions";
import { descendantIds, displayTitle, type NodeId, type Tree } from "./model";

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Body of the delete confirmation: what goes, and how many open tabs it closes unsaved. */
export function deleteWarning(tree: Tree, id: NodeId): string {
  const node = tree.get(id);
  if (!node) return "";
  const nested = descendantIds(tree, id).length;
  const live = summarizeContainer(tree, node).liveTabs + (node.liveTabId !== undefined ? 1 : 0);
  const what = `This removes "${displayTitle(node)}"${nested ? ` and ${nested} nested node(s)` : ""}.`;
  const open = live
    ? ` ${live} open tab${live === 1 ? " is" : "s are"} closed without being saved.`
    : "";
  return `${what}${open} Earlier snapshots in Recovery still contain them.`;
}

/** Whether deleting `id` deserves a confirmation: it has a subtree or mirrors something open. */
export function deleteNeedsConfirmation(tree: Tree, id: NodeId): boolean {
  const node = tree.get(id);
  if (!node) return false;
  const live = node.liveTabId !== undefined || node.liveWindowId !== undefined;
  return live || descendantIds(tree, id).length > 0;
}

export function liveTabCount(tree: Tree): number {
  let n = 0;
  for (const node of tree.values()) if (node.kind === "tab" && node.liveTabId !== undefined) n++;
  return n;
}

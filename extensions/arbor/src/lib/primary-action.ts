import { isBound, type TreeNode } from "./model";

/**
 * What the panel's primary gestures do with a node. Enter, double-click on a tab, the row's
 * Restore button and the context menu's "Restore" / "Reopen" entries all resolve through here (or
 * call `restore` directly), so every entry point reaches the same background handler:
 *
 * - `focus`: the node mirrors an open tab or a bound container (open window); bring it to front.
 * - `restore`: the node is saved; `restoreNode` reopens it *in place* (a tab where it sits, keeping
 *   its parent and children; an unbound container as one new browser window).
 */
export type PrimaryAction = "focus" | "restore";

export function isLiveNode(node: TreeNode): boolean {
  return (node.kind === "tab" && node.liveTabId !== undefined) || isBound(node);
}

export function primaryActionFor(node: TreeNode): PrimaryAction {
  return isLiveNode(node) ? "focus" : "restore";
}

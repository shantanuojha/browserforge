/**
 * Removing containers that have outlived their purpose. Only a container the browser created
 * (no title), that the user left nothing on (no note, no children) and whose window, if still
 * open, has no tabs left is pruned. Anything the user named or annotated is theirs and stays.
 */
import { childrenOf, ops, windowNodeOf, type NodeId, type Tree, type TreeNode } from "../model";
import type { LiveBooks } from "./live-books";
import type { TreeWriter } from "./tree-writer";

export class ContainerPruner {
  constructor(
    private readonly writer: TreeWriter,
    private readonly books: LiveBooks,
  ) {}

  private get tree(): Tree {
    return this.writer.tree;
  }

  /**
   * Whether a container has outlived its purpose: the browser created it (no title), the user
   * left nothing on it (no note, no children of any kind) and, when it still mirrors a browser
   * window, that window has no tabs left (a window showing only a new-tab page is still a window,
   * so its node stays).
   */
  isPrunable(node: TreeNode, closing?: ReadonlySet<number>): boolean {
    if (node.kind !== "window" || node.title || node.note) return false;
    if (childrenOf(this.tree, node.id).length > 0) return false;
    if (
      node.liveWindowId !== undefined &&
      this.books.realTabsRemaining(node.liveWindowId, closing) > 0
    ) {
      return false;
    }
    return true;
  }

  /**
   * Remove untitled containers left without children. The check cascades to a parent container
   * when an emptied one was nested in it. Without `candidates` every container is examined
   * (startup / rebuild sweep). `closing` names browser tabs about to be closed by the caller so
   * a live window whose last tab is being deleted is pruned together with the node, not later
   * from the resulting events. Returns the removed nodes, innermost first.
   */
  pruneEmptyWindows(
    candidates?: Iterable<NodeId | null | undefined>,
    closing?: ReadonlySet<number>,
  ): TreeNode[] {
    const queue = this.initialCandidates(candidates);
    const removed: TreeNode[] = [];
    const seen = new Set<NodeId>();
    while (queue.length) {
      const id = queue.shift() as NodeId;
      if (seen.has(id)) continue;
      seen.add(id);
      const node = this.tree.get(id);
      if (!node || !this.isPrunable(node, closing)) continue;
      this.writer.append([ops.remove(id)]);
      removed.push(node);
      if (node.parentId !== null) {
        seen.delete(node.parentId); // re-examine: it just lost a child
        queue.push(node.parentId);
      }
    }
    return removed;
  }

  private initialCandidates(candidates?: Iterable<NodeId | null | undefined>): NodeId[] {
    const queue: NodeId[] = [];
    if (candidates) {
      for (const id of candidates) if (id) queue.push(id);
    } else {
      for (const n of this.tree.values()) if (n.kind === "window") queue.push(n.id);
    }
    return queue;
  }

  /** Containers to re-examine after `parentId` lost a child: the nearest one at or above it. */
  windowCandidates(parentId: NodeId | null): NodeId[] {
    if (parentId === null) return [];
    const win = windowNodeOf(this.tree, parentId);
    return win ? [win.id] : [];
  }
}

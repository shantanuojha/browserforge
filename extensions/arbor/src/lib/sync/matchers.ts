/**
 * Re-matching the tree to the browser on a rebuild. Works on a snapshot of the tree taken before
 * the rebuild writes anything, so a window node is looked up by the id it carried when its stray
 * tab nodes last saw it. Strategies, in order: same live id (verified by a tab), URL overlap.
 */
import {
  buildChildIndex,
  containerTabs,
  type ChildIndex,
  type NodeId,
  type Tree,
  type TreeNode,
} from "../model";
import { isBlankUrl, type LiveTab } from "./types";
import { currentUrl, sameUrl } from "./url";

export interface WindowMatch {
  node: TreeNode;
  /** Live ids inside this window are trusted (same browser session). */
  idsValid: boolean;
}

/** Lexicographic comparison of rank vectors; missing entries count as 0. */
function better(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/** A blank page on both sides counts as the same page: a window holding only a new tab re-attaches too. */
function samePage(tab: LiveTab, node: TreeNode): boolean {
  const url = currentUrl(tab);
  return sameUrl(url, node.url) || (isBlankUrl(url) && isBlankUrl(node.url));
}

export class RebuildMatcher {
  private readonly index: ChildIndex;
  private readonly windowNodes: TreeNode[];
  private readonly tabNodes: TreeNode[];

  constructor(private readonly tree: Tree) {
    this.index = buildChildIndex(tree);
    this.windowNodes = [...tree.values()].filter((n) => n.kind === "window");
    this.tabNodes = [...tree.values()].filter((n) => n.kind === "tab");
  }

  /**
   * Tab nodes that belong to a container: the tabs of its own subtree (nested containers are
   * windows of their own and are left out) plus any tab node anywhere in the tree that still
   * carries the container's live window id. Drag-and-drop lets a live tab sit outside its
   * window's subtree (in a group, under a closed container...) while the browser tab stays in
   * the window; those nodes must be re-matched too or the rebuild duplicates them.
   */
  tabNodesOf(win: TreeNode): TreeNode[] {
    const out = containerTabs(this.tree, win.id, this.index);
    if (win.liveWindowId === undefined) return out;
    const seen = new Set(out.map((n) => n.id));
    for (const n of this.tabNodes) {
      if (n.liveWindowId === win.liveWindowId && !seen.has(n.id)) out.push(n);
    }
    return out;
  }

  /** The container for browser window `windowId` holding `tabs`, if one can be recognised. */
  matchWindow(
    windowId: number,
    tabs: readonly LiveTab[],
    used: ReadonlySet<NodeId>,
  ): WindowMatch | undefined {
    const byId = this.byLiveId(windowId, tabs, used);
    if (byId) return { node: byId, idsValid: true };
    const byUrl = this.byUrlOverlap(tabs, used);
    return byUrl ? { node: byUrl, idsValid: false } : undefined;
  }

  /**
   * Same live id, verified by at least one tab id still matching with the same url (a blank
   * page on both sides counts: a window holding only a new tab must re-attach too).
   */
  private byLiveId(
    windowId: number,
    tabs: readonly LiveTab[],
    used: ReadonlySet<NodeId>,
  ): TreeNode | undefined {
    const node = this.windowNodes.find((n) => n.liveWindowId === windowId && !used.has(n.id));
    if (!node) return undefined;
    const kids = this.tabNodesOf(node);
    const verified =
      kids.some((k) => tabs.some((t) => t.id === k.liveTabId && samePage(t, k))) ||
      (kids.length === 0 && tabs.every((t) => isBlankUrl(currentUrl(t))));
    return verified ? node : undefined;
  }

  /**
   * URL overlap with a container (session restore gives new ids). Ties go to the container that
   * was bound when we last looked, then to one whose tabs were live, then to an untitled
   * (browser-made) one, so a user's group is not claimed by a window that merely shows the same
   * pages. At least half of the window's meaningful tabs must match.
   */
  private byUrlOverlap(tabs: readonly LiveTab[], used: ReadonlySet<NodeId>): TreeNode | undefined {
    const meaningful = tabs.filter((t) => !isBlankUrl(currentUrl(t))).length;
    if (meaningful === 0) return undefined;
    let best: { node: TreeNode; rank: number[] } | undefined;
    for (const n of this.windowNodes) {
      if (used.has(n.id)) continue;
      const rank = this.overlapRank(n, tabs);
      if (rank && (!best || better(rank, best.rank))) best = { node: n, rank };
    }
    const threshold = Math.max(1, Math.ceil(meaningful / 2));
    return best && (best.rank[0] ?? 0) >= threshold ? best.node : undefined;
  }

  /** `[matching tabs, was bound, had live tabs, untitled]`; `undefined` when nothing matches. */
  private overlapRank(node: TreeNode, tabs: readonly LiveTab[]): number[] | undefined {
    const kids = this.tabNodesOf(node);
    const urls = kids.map((k) => k.url);
    const score = tabs.filter((t) => urls.some((u) => sameUrl(u, currentUrl(t)))).length;
    if (score === 0) return undefined;
    return [
      score,
      node.liveWindowId !== undefined ? 1 : 0,
      kids.some((k) => k.liveTabId !== undefined) ? 1 : 0,
      node.title ? 0 : 1,
    ];
  }

  /**
   * The saved or live node among `candidates` that `tab` is: by live id when ids are trusted,
   * else a saved node with the same url, else any node with the same url.
   */
  matchTab(
    tab: LiveTab,
    candidates: readonly TreeNode[],
    options: { idsValid: boolean; used: ReadonlySet<NodeId> },
  ): TreeNode | undefined {
    const free = (k: TreeNode) => !options.used.has(k.id);
    const url = currentUrl(tab);
    const byId = options.idsValid
      ? candidates.find((k) => free(k) && k.liveTabId === tab.id)
      : undefined;
    return (
      byId ??
      candidates.find((k) => free(k) && k.liveTabId === undefined && sameUrl(k.url, url)) ??
      candidates.find((k) => free(k) && sameUrl(k.url, url))
    );
  }
}

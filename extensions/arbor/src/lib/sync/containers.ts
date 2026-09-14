/**
 * User actions on containers and tabs that reach the browser: focus, close-and-save, restore,
 * reopen (in place or as a window), and the undo/redo variants that act on exact node sets.
 *
 * Containers: there is one container kind, `window`. A container is *bound* while it mirrors an
 * open browser window (`liveWindowId` set) and *unbound* otherwise; a user group is an unbound
 * container with a title. "Reopen all" on an unbound container opens it as a new browser window
 * (closed tabs open there, tabs still open elsewhere are moved in); on a bound one it reopens
 * the closed tabs into that window at their tree positions. Nested containers are windows of
 * their own and are never reopened by their parent.
 */
import {
  containerTabs,
  descendantIds,
  windowNodeOf,
  type NodeId,
  type OpBody,
  type Tree,
  type TreeNode,
} from "../model";
import type { TreeStore } from "../store/types";
import type { AdoptionRegistry } from "./adoption";
import type { LiveBooks } from "./live-books";
import type { Placement } from "./placement";
import type { ContainerPruner } from "./pruning";
import { isSavedTabWithUrl, TabReopener } from "./reopen";
import type { TreeWriter } from "./tree-writer";
import type { TabsPort } from "./types";

export interface ContainerOperationsDeps {
  store: TreeStore;
  port: TabsPort;
  writer: TreeWriter;
  books: LiveBooks;
  placement: Placement;
  pruner: ContainerPruner;
  adoptions: AdoptionRegistry;
}

/** Live tab ids at or beneath a node, nested containers included (their windows close too). */
export function liveTabIdsIn(tree: Tree, nodeId: NodeId): number[] {
  const ids: number[] = [];
  const self = tree.get(nodeId);
  if (!self) return ids;
  if (self.kind === "tab" && self.liveTabId !== undefined) ids.push(self.liveTabId);
  for (const id of descendantIds(tree, nodeId)) {
    const n = tree.get(id);
    if (n?.kind === "tab" && n.liveTabId !== undefined) ids.push(n.liveTabId);
  }
  return ids;
}

export class ContainerOperations {
  private readonly store: TreeStore;
  private readonly port: TabsPort;
  private readonly writer: TreeWriter;
  private readonly books: LiveBooks;
  private readonly pruner: ContainerPruner;
  private readonly reopener: TabReopener;

  constructor(deps: ContainerOperationsDeps) {
    this.store = deps.store;
    this.port = deps.port;
    this.writer = deps.writer;
    this.books = deps.books;
    this.pruner = deps.pruner;
    this.reopener = new TabReopener(deps);
  }

  private get tree(): Tree {
    return this.writer.tree;
  }

  /**
   * Whether a container's window is one the tracker currently sees open. A binding to a window
   * we know nothing about (its close event never reached us) is stale: the container is treated
   * as closed, and reopening it starts from a clean binding.
   */
  isOpenContainer(node: TreeNode): boolean {
    if (node.kind !== "window" || node.liveWindowId === undefined) return false;
    return this.books.seesWindowOpen(node.liveWindowId);
  }

  async focus(nodeId: NodeId): Promise<void> {
    const node = this.tree.get(nodeId);
    if (!node) return;
    if (node.kind === "tab" && node.liveTabId !== undefined && node.liveWindowId !== undefined) {
      await this.port.focusTab(node.liveTabId, node.liveWindowId);
      return;
    }
    if (node.kind === "window" && node.liveWindowId !== undefined) {
      const active = this.books.activeOrFirstTab(node.liveWindowId);
      if (active !== undefined) await this.port.focusTab(active, node.liveWindowId);
    }
  }

  /** Close the live tabs in a subtree; the resulting events turn them into saved nodes. */
  async closeAndSave(nodeId: NodeId): Promise<number> {
    const ids = liveTabIdsIn(this.tree, nodeId);
    if (ids.length) await this.port.removeTabs(ids);
    return ids.length;
  }

  /**
   * Panic button. Marks everything saved *first* and flushes, then closes tabs. A blank tab is
   * opened in the current window so the browser (and this extension) stay alive.
   */
  async closeAllAndSave(): Promise<number> {
    const batch: OpBody[] = [];
    const tabIds: number[] = [];
    for (const n of this.tree.values()) {
      if (n.kind === "tab" && n.liveTabId !== undefined) {
        tabIds.push(n.liveTabId);
        batch.push(this.writer.saveOrDrop(n));
      } else if (n.kind === "window" && n.liveWindowId !== undefined) {
        batch.push(this.writer.unbindWindow(n.id));
      }
    }
    this.writer.append(batch);
    await this.store.compact(true);
    const windowId = this.books.focusedWindowId ?? (await this.port.currentWindowId());
    const keepAlive = await this.port.createTab({ url: "about:blank", windowId, active: true });
    const toClose = new Set(tabIds);
    for (const t of this.books.tabRecords()) toClose.add(t.id);
    toClose.delete(keepAlive.id);
    if (toClose.size) await this.port.removeTabs([...toClose]);
    // Windows other than the keep-alive one close with their tabs; drop empty untitled containers.
    this.pruner.pruneEmptyWindows();
    return toClose.size;
  }

  /**
   * Reopen a saved node in place: the node itself becomes live again with the same parent,
   * position and children.
   *
   * - A tab node under a bound container opens in that window at the strip index matching its
   *   place in the tree. Anywhere else (unbound container, root) it opens in the focused window
   *   and becomes a detached live tab. Its saved children stay saved.
   * - An unbound container opens as a new browser window (see `reopenAll`); a bound one is focused.
   * - A note has nothing to reopen.
   */
  async restore(nodeId: NodeId): Promise<void> {
    const node = this.tree.get(nodeId);
    if (!node) return;
    if (node.kind === "tab") {
      if (node.liveTabId !== undefined) return this.focus(nodeId);
      await this.reopener.reopenTab(node, true);
      return;
    }
    if (this.isOpenContainer(node)) return this.focus(nodeId);
    await this.reopenAll(nodeId);
  }

  /**
   * "Reopen all" on a container. The tabs it acts on are every tab node in its own subtree, no
   * matter how they got there (created in it, dragged in while open or closed, imported), with
   * nested containers left alone: each of those is a window of its own with its own Reopen.
   *
   * - Unbound container: opens a new browser window holding its closed tabs in tree order,
   *   moves in the tabs that are open elsewhere, and binds the container to that window.
   * - Bound container: its closed tabs open into that window at their tree positions.
   *
   * Returns how many tabs were opened or moved in.
   */
  async reopenAll(nodeId: NodeId): Promise<number> {
    const node = this.tree.get(nodeId);
    if (!node) return 0;
    if (node.kind !== "window") {
      // Not a container (a note): reopen whatever saved tabs sit beneath it, in place.
      const saved = descendantIds(this.tree, nodeId)
        .map((id) => this.tree.get(id))
        .filter((n): n is TreeNode => !!n && n.kind === "tab" && n.liveTabId === undefined);
      return this.reopener.reopenTabsInPlace(saved);
    }
    if (!this.isOpenContainer(node)) return this.reopener.reopenAsWindow(node);
    this.reopener.unmarkStaleLive(containerTabs(this.tree, nodeId));
    return this.reopener.reopenTabsInPlace(containerTabs(this.tree, nodeId));
  }

  /**
   * Reopen exactly these saved tab nodes (undo of close-and-save, redo of a reopen). With
   * `container` (the container the original action was run on, when it was closed as a whole or
   * reopened as a window) the container comes back as one browser window holding those tabs;
   * nested containers among them come back as their own windows. Otherwise the tabs open one by
   * one where they sit, like `restore` does. Nodes that are not saved tabs with a url are
   * skipped. Returns the count.
   */
  async reopenNodes(ids: readonly NodeId[], container?: NodeId): Promise<number> {
    const only = new Set(ids);
    let opened = 0;
    const reopenedAs = new Set<NodeId>();
    const asWindow = async (id: NodeId): Promise<void> => {
      const c = this.tree.get(id);
      if (!c || c.kind !== "window" || this.isOpenContainer(c) || reopenedAs.has(id)) return;
      reopenedAs.add(id);
      opened += await this.reopener.reopenAsWindow(c, only);
    };
    if (container) await asWindow(container);
    const rest: TreeNode[] = [];
    for (const id of ids) {
      const n = this.tree.get(id);
      if (!isSavedTabWithUrl(n)) continue;
      const c = container ? windowNodeOf(this.tree, id) : undefined;
      if (c && !this.isOpenContainer(c) && !reopenedAs.has(c.id)) await asWindow(c.id);
      if (this.tree.get(id)?.liveTabId === undefined) rest.push(n);
    }
    opened += await this.reopener.reopenTabsInPlace(rest);
    return opened;
  }

  /**
   * Close the browser tabs of exactly these nodes (undo of a reopen, redo of close-and-save).
   * The resulting events turn the nodes into saved nodes in place; a window emptied this way
   * closes, and its container stays in the tree unbound. Returns the count.
   */
  async closeNodes(ids: readonly NodeId[]): Promise<number> {
    const tabIds: number[] = [];
    for (const id of ids) {
      const n = this.tree.get(id);
      if (n && n.kind === "tab" && n.liveTabId !== undefined) tabIds.push(n.liveTabId);
    }
    if (tabIds.length) await this.port.removeTabs(tabIds);
    return tabIds.length;
  }
}

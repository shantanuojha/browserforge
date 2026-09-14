/**
 * How saved nodes become live again: a single tab reopened where it sits, a set of tabs reopened
 * one by one, or a whole container reopened as a new browser window. Owns the dance with the
 * adoption registry so the tabs the browser creates land on their saved nodes.
 */
import { errorMessage } from "@browserforge/shared";
import {
  childrenOf,
  containerTabs,
  findByLiveTabId,
  ops,
  windowNodeOf,
  type NodeId,
  type OpBody,
  type Tree,
  type TreeNode,
} from "../model";
import type { AdoptionRegistry, WindowAdoption } from "./adoption";
import type { LiveBooks } from "./live-books";
import type { Placement } from "./placement";
import { savedTabByUrl } from "./saved-tabs";
import type { TreeWriter } from "./tree-writer";
import type { LiveTab, LiveWindow, TabsPort } from "./types";
import { targetUrl } from "./url";

export interface TabReopenerDeps {
  port: TabsPort;
  writer: TreeWriter;
  books: LiveBooks;
  placement: Placement;
  adoptions: AdoptionRegistry;
}

type CreatedWindow = { window: LiveWindow; tabs: LiveTab[] };

export const isSavedTabWithUrl = (n: TreeNode | undefined): n is TreeNode =>
  !!n && n.kind === "tab" && n.liveTabId === undefined && !!n.url;

export class TabReopener {
  private readonly port: TabsPort;
  private readonly writer: TreeWriter;
  private readonly books: LiveBooks;
  private readonly placement: Placement;
  private readonly adoptions: AdoptionRegistry;

  constructor(deps: TabReopenerDeps) {
    this.port = deps.port;
    this.writer = deps.writer;
    this.books = deps.books;
    this.placement = deps.placement;
    this.adoptions = deps.adoptions;
  }

  private get tree(): Tree {
    return this.writer.tree;
  }

  /**
   * A tab node that still claims a browser tab the tracker does not know: its close event never
   * reached us (or a matching rebuild re-marked it live from stale data). It is closed for every
   * practical purpose, so it is treated as saved rather than skipped.
   */
  private isStaleLive(node: TreeNode): boolean {
    return (
      node.kind === "tab" && node.liveTabId !== undefined && !this.books.hasTab(node.liveTabId)
    );
  }

  /** Clear stale live ids so the nodes count as closed (see `isStaleLive`). */
  unmarkStaleLive(nodes: readonly TreeNode[]): void {
    const batch = nodes
      .filter((n) => this.isStaleLive(n))
      .map((n) => ops.update(n.id, { liveTabId: undefined, liveWindowId: undefined }));
    this.writer.append(batch);
  }

  /** Open a browser tab for saved tab `node` so that `node` itself becomes live in place. */
  async reopenTab(node: TreeNode, active: boolean): Promise<void> {
    if (!node.url) return;
    const windowNode = windowNodeOf(this.tree, node.id);
    const liveWindowId = windowNode?.liveWindowId;
    const windowId =
      liveWindowId ?? this.books.focusedWindowId ?? (await this.port.currentWindowId());
    const index =
      windowNode && liveWindowId !== undefined
        ? this.placement.stripIndexFor(node.id, windowNode, liveWindowId)
        : undefined;
    const adoption = this.adoptions.expectTab(node.id, node.url, windowId);
    let tab: LiveTab;
    try {
      tab = await this.port.createTab({ url: node.url, windowId, index, active });
    } catch (e) {
      this.adoptions.forget(adoption);
      throw e;
    }
    this.finishTabAdoption(node.id, tab);
  }

  /**
   * Open the closed tabs among `nodes` one by one where they sit; the rest are left alone. Each
   * `tabs.create` is awaited so the pending restores match their `onCreated` events in order even
   * when urls repeat. One tab that cannot be opened does not stop the others; the error is
   * reported after the rest were tried.
   */
  async reopenTabsInPlace(nodes: readonly TreeNode[]): Promise<number> {
    let opened = 0;
    const failures: unknown[] = [];
    for (const n of nodes) {
      const current = this.tree.get(n.id);
      if (!isSavedTabWithUrl(current)) continue;
      try {
        await this.reopenTab(current, false);
        opened++;
      } catch (e) {
        failures.push(e);
      }
    }
    if (failures.length) {
      throw new Error(
        `${failures.length} of ${opened + failures.length} tabs could not be opened: ${errorMessage(failures[0])}`,
      );
    }
    return opened;
  }

  /**
   * Open an unbound container as a new browser window. Its closed tabs (or just the ones in
   * `only`) open there in tree order and are adopted by their nodes; tabs of the container that
   * are open in other windows are moved in afterwards so the window matches the tree. The
   * container is bound to the new window. Nested containers are not touched.
   */
  async reopenAsWindow(node: TreeNode, only?: ReadonlySet<NodeId>): Promise<number> {
    const nodeId = node.id;
    // A binding to a window we no longer see is stale; start from a closed container.
    if (node.liveWindowId !== undefined) this.writer.append([this.writer.unbindWindow(nodeId)]);
    const pick = (n: TreeNode) => !!n.url && (!only || only.has(n.id));
    this.unmarkStaleLive(containerTabs(this.tree, nodeId).filter(pick));
    const tabs = containerTabs(this.tree, nodeId).filter(pick);
    const closed = tabs.filter((n) => n.liveTabId === undefined);
    const elsewhere = tabs.filter((n) => n.liveTabId !== undefined);
    if (!closed.length && !elsewhere.length) return 0;
    const urls = closed.map((n) => n.url as string);
    // With nothing closed to open, the window is built around one of the open tabs instead.
    const seed = urls.length ? undefined : (elsewhere[0]?.liveTabId as number);
    const created = await this.createWindowFor({ nodeId, urls, only }, seed);
    this.bindReopenedWindow(nodeId, created, only);
    const moved = await this.gatherLiveTabs(nodeId, created.window.id);
    return urls.length + moved + (seed === undefined ? 0 : 1);
  }

  /** `windows.create` with the adoption registered for the `onCreated` events it triggers. */
  private async createWindowFor(
    adoption: WindowAdoption,
    seed: number | undefined,
  ): Promise<CreatedWindow> {
    this.adoptions.expectWindow(adoption);
    try {
      return await this.port.createWindow(adoption.urls, seed);
    } finally {
      this.adoptions.clearWindow();
    }
  }

  /** After `windows.create` resolved: bind the container and let its saved tabs own the new tabs. */
  private bindReopenedWindow(
    nodeId: NodeId,
    created: CreatedWindow,
    only: ReadonlySet<NodeId> | undefined,
  ): void {
    const current = this.tree.get(nodeId);
    if (current && current.liveWindowId === undefined) {
      this.writer.append([ops.update(nodeId, { liveWindowId: created.window.id })]);
    }
    const claim = { used: new Set<NodeId>(), only };
    for (const t of created.tabs) {
      const url = targetUrl(t);
      const target = url ? savedTabByUrl(this.tree, nodeId, url, claim) : undefined;
      if (!target) continue;
      claim.used.add(target.id);
      this.finishTabAdoption(target.id, t);
    }
    this.adoptions.forgetWindowTabs(created.window.id);
    this.foldDuplicateWindowNodes(nodeId, created.window.id);
  }

  /**
   * Move the container's live tabs that sit in other browser windows into `windowId`, each at
   * the strip index its tree position calls for. The resulting attach events only update
   * `liveWindowId`: the nodes already sit where the user put them.
   */
  private async gatherLiveTabs(containerId: NodeId, windowId: number): Promise<number> {
    const desired = this.placement.attachedOrderInTree(this.tree.get(containerId) as TreeNode);
    const present = new Set(this.books.stripOf(windowId) ?? []);
    let moved = 0;
    for (const [pos, tabId] of desired.entries()) {
      if (present.has(tabId) || !this.books.hasTab(tabId)) continue;
      const index = desired.slice(0, pos).filter((id) => present.has(id)).length;
      try {
        await this.port.moveTab(tabId, windowId, index);
        present.add(tabId);
        moved++;
      } catch {
        // The tab vanished meanwhile; its close event will save the node.
      }
    }
    return moved;
  }

  /**
   * `tabs.onCreated` may reach us before `windows.onCreated` while a container reopens as a
   * window; the tabs then conjure a second node for the new window. Fold it into the reopened
   * container.
   */
  private foldDuplicateWindowNodes(keepId: NodeId, windowId: number): void {
    for (const dup of [...this.tree.values()]) {
      if (dup.kind !== "window" || dup.id === keepId || dup.liveWindowId !== windowId) continue;
      const batch: OpBody[] = [];
      let at = childrenOf(this.tree, keepId).length;
      for (const kid of childrenOf(this.tree, dup.id)) batch.push(ops.move(kid.id, keepId, at++));
      batch.push(ops.remove(dup.id));
      this.writer.append(batch);
    }
  }

  /** After `tabs.create` resolves make sure the saved node (not a duplicate) owns the tab. */
  private finishTabAdoption(nodeId: NodeId, tab: LiveTab): void {
    this.adoptions.forgetNode(nodeId);
    const tree = this.tree;
    const node = tree.get(nodeId);
    if (!node) return;
    if (node.liveTabId === tab.id) return;
    const duplicate = findByLiveTabId(tree, tab.id);
    const batch: OpBody[] = [];
    if (duplicate && duplicate.id !== nodeId) {
      for (const kid of childrenOf(tree, duplicate.id)) {
        batch.push(ops.move(kid.id, nodeId, childrenOf(tree, nodeId).length));
      }
      batch.push(ops.remove(duplicate.id));
    }
    this.writer.append(batch);
    if (!this.books.hasTab(tab.id)) this.books.insertTabRecord(tab);
    this.writer.adoptNode(this.tree.get(nodeId) ?? node, tab);
  }
}

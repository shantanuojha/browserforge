/**
 * Mirrors live windows and tabs into the tree. Pure with respect to the browser: events are fed
 * through `handle*` methods and browser mutations go through the injected `TabsPort`.
 *
 * `TabTracker` is a facade over collaborators that each own one concern:
 * - `LiveBooks`: the browser's own state (strips, tab records, active tabs, focused window);
 * - `TreeWriter`: the tree-side vocabulary (window node on demand, tab nodes, patches, save-or-drop);
 * - `Placement`: where a tab belongs in the tree and where a node belongs in the strip;
 * - `ContainerPruner`: removing untitled containers left empty;
 * - `AdoptionRegistry`: restores in flight, so created tabs reuse their saved nodes;
 * - `LiveMirror`: the browser events (`TrackerEventSink`);
 * - `Rebuilder` + `RebuildMatcher`: re-matching the tree to the browser on startup;
 * - `ContainerOperations`: focus, close-and-save, restore, reopen (in place or as a window);
 * - `TreeEdits`: remove (tree only), close-and-remove and move from the panel, with the browser
 *   following where it must;
 * - `runHistoryStep`: undo/redo steps mapped onto the same operations.
 *
 * Invariants it maintains:
 * - a live tab node has `liveTabId` and `liveWindowId`; the tracker creates it under the matching
 *   bound container, but the user may drag it anywhere (see `Placement.isDetached`);
 * - a closed tab becomes a saved node (live ids cleared) unless it was a blank new tab; a saved
 *   node the user reopens becomes live again where it sits (same parent, position and children);
 * - the depth-first order of the live tab nodes attached to a bound container follows the
 *   browser's tab strip (detached tabs and nested containers skipped) whenever the tracker itself
 *   changed the tree; user nesting is preserved otherwise;
 * - a container whose browser window closes stays in the tree, unbound, with its tabs saved in
 *   place. Only an untitled, note-less container left without children is removed.
 */
import type { Clock } from "@browserforge/shared";
import type { HistoryStep } from "../history";
import type { NodeId, OpBody, Tree, TreeNode } from "../model";
import type { TreeStore } from "../store/types";
import { AdoptionRegistry } from "./adoption";
import { ContainerOperations, liveTabIdsIn } from "./containers";
import { TreeEdits } from "./edits";
import { runHistoryStep, type StepTarget } from "./history-runner";
import { LiveBooks, type LiveState } from "./live-books";
import { LiveMirror } from "./mirror";
import { Placement } from "./placement";
import { ContainerPruner } from "./pruning";
import { Rebuilder } from "./rebuild";
import { TreeWriter } from "./tree-writer";
import type { LiveTab, LiveWindow, RebuildReport, TabsPort, TrackerEventSink } from "./types";

export type { LiveState } from "./live-books";

export interface TrackerOptions {
  newId: () => string;
  clock: Clock;
}

export class TabTracker implements TrackerEventSink, StepTarget {
  private readonly books = new LiveBooks();
  private readonly writer: TreeWriter;
  private readonly mirror: LiveMirror;
  private readonly rebuilder: Rebuilder;
  private readonly containers: ContainerOperations;
  private readonly edits: TreeEdits;

  constructor(
    store: TreeStore,
    private readonly port: TabsPort,
    options: TrackerOptions,
  ) {
    const adoptions = new AdoptionRegistry(options.clock);
    this.writer = new TreeWriter(store, options.newId, options.clock);
    const placement = new Placement(this.writer, this.books);
    const pruner = new ContainerPruner(this.writer, this.books);
    const shared = { writer: this.writer, books: this.books, placement, pruner, adoptions };
    this.mirror = new LiveMirror(shared);
    this.rebuilder = new Rebuilder({ ...shared, mirror: this.mirror });
    this.containers = new ContainerOperations({ ...shared, store, port });
    this.edits = new TreeEdits({ ...shared, port });
  }

  get tree(): Tree {
    return this.writer.tree;
  }

  append(bodies: readonly OpBody[]): void {
    this.writer.append(bodies);
  }

  getLiveState(): LiveState {
    return this.books.getLiveState();
  }

  // -- browser events -------------------------------------------------------------------------

  handleTabCreated(tab: LiveTab): void {
    this.mirror.handleTabCreated(tab);
  }

  handleTabUpdated(tabId: number, tab: LiveTab): void {
    this.mirror.handleTabUpdated(tabId, tab);
  }

  handleTabMoved(tabId: number, info: { windowId: number; toIndex: number }): void {
    this.mirror.handleTabMoved(tabId, info);
  }

  handleTabAttached(tabId: number, info: { newWindowId: number; newPosition: number }): void {
    this.mirror.handleTabAttached(tabId, info);
  }

  handleTabDetached(tabId: number, info: { oldWindowId: number }): void {
    this.mirror.handleTabDetached(tabId, info);
  }

  handleTabRemoved(tabId: number): void {
    this.mirror.handleTabRemoved(tabId);
  }

  handleTabReplaced(addedTabId: number, removedTabId: number): void {
    this.mirror.handleTabReplaced(addedTabId, removedTabId);
  }

  handleTabActivated(info: { tabId: number; windowId: number }): void {
    this.mirror.handleTabActivated(info);
  }

  handleWindowCreated(win: LiveWindow): void {
    this.mirror.handleWindowCreated(win);
  }

  handleWindowRemoved(windowId: number): void {
    this.mirror.handleWindowRemoved(windowId);
  }

  handleWindowFocusChanged(windowId: number | undefined): void {
    this.mirror.handleWindowFocusChanged(windowId);
  }

  // -- startup --------------------------------------------------------------------------------

  /** Rebuild live state from the browser (service worker restart, browser restart, first run). */
  async rebuild(): Promise<RebuildReport> {
    const { tabs, windows } = await this.port.queryAll();
    return this.rebuildFrom(tabs, windows);
  }

  rebuildFrom(tabs: LiveTab[], windows: LiveWindow[]): RebuildReport {
    return this.rebuilder.rebuildFrom(tabs, windows);
  }

  // -- user actions ---------------------------------------------------------------------------

  /** Live tab ids at or beneath a node, nested containers included (their windows close too). */
  liveTabIdsIn(nodeId: NodeId): number[] {
    return liveTabIdsIn(this.tree, nodeId);
  }

  focus(nodeId: NodeId): Promise<void> {
    return this.containers.focus(nodeId);
  }

  closeAndSave(nodeId: NodeId): Promise<number> {
    return this.containers.closeAndSave(nodeId);
  }

  closeAllAndSave(): Promise<number> {
    return this.containers.closeAllAndSave();
  }

  restore(nodeId: NodeId): Promise<void> {
    return this.containers.restore(nodeId);
  }

  reopenAll(nodeId: NodeId): Promise<number> {
    return this.containers.reopenAll(nodeId);
  }

  /** "Remove from tree": tree only; open tabs stay open and re-mirrored under their window. */
  removeNode(nodeId: NodeId): TreeNode[] {
    return this.edits.removeNode(nodeId);
  }

  /** "Close tabs and remove": closes the open tabs beneath the node, then removes the subtree. */
  closeAndRemove(nodeId: NodeId): Promise<TreeNode[]> {
    return this.edits.closeAndRemove(nodeId);
  }

  moveNode(nodeId: NodeId, parentId: NodeId | null, index: number): Promise<TreeNode[]> {
    return this.edits.moveNode(nodeId, parentId, index);
  }

  // -- undo / redo ----------------------------------------------------------------------------

  reopenNodes(ids: readonly NodeId[], container?: NodeId): Promise<number> {
    return this.containers.reopenNodes(ids, container);
  }

  closeNodes(ids: readonly NodeId[]): Promise<number> {
    return this.containers.closeNodes(ids);
  }

  runHistoryStep(step: HistoryStep): Promise<void> {
    return runHistoryStep(this, step);
  }
}

/**
 * Rebuild live state from the browser (service worker restart, browser restart, first run).
 * Matches windows/tabs to existing nodes by live ids when they are still valid, otherwise by
 * URL overlap; everything that no longer exists becomes a saved node.
 */
import { migrationOps } from "../migrate";
import { ops, type NodeId, type OpBody, type Tree, type TreeNode } from "../model";
import type { AdoptionRegistry } from "./adoption";
import type { LiveBooks } from "./live-books";
import { RebuildMatcher } from "./matchers";
import type { LiveMirror } from "./mirror";
import type { ContainerPruner } from "./pruning";
import type { TreeWriter } from "./tree-writer";
import { isTrackableWindow, type LiveTab, type LiveWindow, type RebuildReport } from "./types";

export interface RebuilderDeps {
  writer: TreeWriter;
  books: LiveBooks;
  adoptions: AdoptionRegistry;
  pruner: ContainerPruner;
  mirror: LiveMirror;
}

/** A browser window and the container recognised for it (`null`: a new one is created). */
interface Assignment {
  windowId: number;
  node: TreeNode | null;
  tabs: LiveTab[];
  /** Live ids inside this window are trusted (same browser session). */
  idsValid: boolean;
}

function emptyReport(): RebuildReport {
  return {
    windowsMatched: 0,
    windowsCreated: 0,
    tabsMatched: 0,
    tabsCreated: 0,
    nodesSaved: 0,
    nodesDropped: 0,
    windowsPruned: 0,
    migrated: 0,
  };
}

export class Rebuilder {
  private readonly writer: TreeWriter;
  private readonly books: LiveBooks;
  private readonly adoptions: AdoptionRegistry;
  private readonly pruner: ContainerPruner;
  private readonly mirror: LiveMirror;

  constructor(deps: RebuilderDeps) {
    this.writer = deps.writer;
    this.books = deps.books;
    this.adoptions = deps.adoptions;
    this.pruner = deps.pruner;
    this.mirror = deps.mirror;
  }

  private get tree(): Tree {
    return this.writer.tree;
  }

  rebuildFrom(tabs: LiveTab[], windows: LiveWindow[]): RebuildReport {
    const report = emptyReport();
    this.books.reset();
    this.adoptions.reset();
    report.migrated = this.migrate();
    const liveTabs = this.recordBrowser(tabs, windows);
    // The matcher works on the tree as it is now: window nodes keep the ids their stray tab
    // nodes still reference until the window batch below rebinds them.
    const matcher = new RebuildMatcher(this.tree);
    const assignments = this.assignWindows(matcher, windows.filter(isTrackableWindow), liveTabs);
    report.windowsMatched = assignments.filter((a) => a.node !== null).length;
    report.windowsCreated = assignments.length - report.windowsMatched;
    report.nodesSaved += this.bindWindows(assignments);
    const usedTabNodes = this.assignTabs(matcher, assignments, report);
    this.saveStaleTabs(usedTabNodes, report);
    // Sweep: untitled containers that ended up childless (including ones older versions left
    // behind) go, unless their browser window is open with at least one tab. Logged as ops.
    report.windowsPruned = this.pruner.pruneEmptyWindows().length;
    return report;
  }

  /** Trees written by older versions are brought up to date first, as ordinary logged ops. */
  private migrate(): number {
    const migration = migrationOps(this.tree);
    this.writer.append(migration);
    return migration.length;
  }

  /** Note every window and record the tabs of the trackable ones in strip order. */
  private recordBrowser(tabs: LiveTab[], windows: LiveWindow[]): LiveTab[] {
    for (const w of windows) this.books.noteWindow(w.id, isTrackableWindow(w));
    const trackable = windows.filter(isTrackableWindow);
    const trackableIds = new Set(trackable.map((w) => w.id));
    const liveTabs = tabs
      .filter((t) => trackableIds.has(t.windowId))
      .sort((a, b) => a.windowId - b.windowId || a.index - b.index);
    for (const t of liveTabs) this.books.insertTabRecord(t);
    this.books.focusedWindowId = trackable.find((w) => w.focused)?.id;
    return liveTabs;
  }

  private assignWindows(
    matcher: RebuildMatcher,
    trackable: readonly LiveWindow[],
    liveTabs: readonly LiveTab[],
  ): Assignment[] {
    const used = new Set<NodeId>();
    return trackable.map((w) => {
      const tabs = liveTabs.filter((t) => t.windowId === w.id);
      const match = matcher.matchWindow(w.id, tabs, used);
      if (!match) return { windowId: w.id, node: null, tabs, idsValid: false };
      used.add(match.node.id);
      return { windowId: w.id, node: match.node, tabs, idsValid: match.idsValid };
    });
  }

  /**
   * Bind matched containers to their windows and unbind every other container still carrying a
   * live id: nothing confirmed it. Applied first so tab placement sees consistent window nodes.
   * Returns how many containers became saved.
   */
  private bindWindows(assignments: readonly Assignment[]): number {
    const batch: OpBody[] = [];
    const matched = new Set<NodeId>();
    for (const a of assignments) {
      if (!a.node) continue;
      matched.add(a.node.id);
      if (a.node.liveWindowId !== a.windowId) {
        batch.push(ops.update(a.node.id, { liveWindowId: a.windowId }));
      }
    }
    let saved = 0;
    for (const n of this.tree.values()) {
      if (n.kind === "window" && n.liveWindowId !== undefined && !matched.has(n.id)) {
        batch.push(this.writer.unbindWindow(n.id));
        saved++;
      }
    }
    this.writer.append(batch);
    return saved;
  }

  /** Match each window's tabs to its container's nodes; create nodes for the rest. */
  private assignTabs(
    matcher: RebuildMatcher,
    assignments: readonly Assignment[],
    report: RebuildReport,
  ): Set<NodeId> {
    const used = new Set<NodeId>();
    for (const assignment of assignments) {
      // A window that did not match has no nodes to offer; its tabs are all created below.
      const candidates = assignment.node ? matcher.tabNodesOf(assignment.node) : [];
      if (!assignment.node) this.writer.windowNodeFor(assignment.windowId);
      const batch: OpBody[] = [];
      const deferred: LiveTab[] = [];
      for (const t of assignment.tabs) {
        const node = matcher.matchTab(t, candidates, { idsValid: assignment.idsValid, used });
        if (!node) {
          deferred.push(t);
          continue;
        }
        used.add(node.id);
        report.tabsMatched++;
        const patch = this.writer.patchFor(node, t);
        if (patch) batch.push(ops.update(node.id, patch));
      }
      this.writer.append(batch);
      for (const t of deferred) {
        report.tabsCreated++;
        used.add(this.mirror.adoptOrCreate(t));
      }
    }
    return used;
  }

  /** Stale live tab nodes -> saved (or dropped when blank). */
  private saveStaleTabs(used: ReadonlySet<NodeId>, report: RebuildReport): void {
    const cleanup: OpBody[] = [];
    for (const n of this.tree.values()) {
      if (n.kind !== "tab" || n.liveTabId === undefined || used.has(n.id)) continue;
      const op = this.writer.saveOrDrop(n);
      if (op.type === "remove") report.nodesDropped++;
      else report.nodesSaved++;
      cleanup.push(op);
    }
    this.writer.append(cleanup);
  }
}

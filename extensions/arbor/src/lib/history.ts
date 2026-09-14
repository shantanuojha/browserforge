/**
 * Undo / redo for user-initiated tree edits in the side panel.
 *
 * There is no second history mechanism. An undo is the *inverse* of what an action did, expressed
 * as ordinary ops appended to the same op log (or as the same tracker call a user gesture makes,
 * when live tabs are involved): re-adding a deleted subtree is a batch of `add` ops with the
 * original ids; undoing a move is a move back; undoing close-and-save reopens the very same nodes
 * in place; undoing a reopen closes exactly those tabs again. The panel keeps a short stack of
 * such entries for its session.
 *
 * Design choices, in case they come up:
 * - Entries are self-contained: they carry the nodes they re-add and the ids they act on, never
 *   op sequence numbers. Log compaction therefore cannot make an entry unreplayable, so nothing
 *   is cleared when the store compacts. Instead every step is validated when it runs: a missing
 *   node or parent fails the step with a message and the panel drops the entry.
 * - Depth is capped at `HISTORY_DEPTH` entries; older ones fall off the bottom.
 * - Collapse/expand is presentation and is not recorded.
 * - The stack is per panel session, mirrored into `storage.session` when available so it survives
 *   the side panel being closed and reopened within one browser session (panels in different
 *   windows share it, last writer wins). It does not survive a browser restart.
 *
 * Pure: no DOM, no `browser.*`. The panel builds entries from the tree it shows and the response
 * of the mutating message; the background runs steps (`TabTracker.runHistoryStep`).
 */

import {
  applyOp,
  childrenOf,
  containerTabs,
  descendantIds,
  displayTitle,
  isBound,
  isContainer,
  ops,
  type NodeId,
  type NodePatch,
  type OpBody,
  type Tree,
  type TreeNode,
} from "./model";

export const HISTORY_DEPTH = 50;

/** One thing the background does on behalf of an undo or redo. */
export type HistoryStep =
  /** Plain tree edits: updates, and adds that put removed nodes back (same ids, saved). */
  | { kind: "ops"; ops: OpBody[] }
  /** Remove a node the user created, but only while it is still empty. */
  | { kind: "removeEmpty"; id: NodeId }
  /** `TabTracker.moveNode`: the browser tab follows when it has to. */
  | { kind: "move"; id: NodeId; parentId: NodeId | null; index: number }
  /** `TabTracker.deleteNode`: subtree removal with window pruning, closes live tabs. */
  | { kind: "delete"; id: NodeId }
  /**
   * `TabTracker.reopenNodes`: these saved nodes become live in place. With `container` (the
   * container the action was run on: a window closed as a whole, a group reopened as a window)
   * they come back together as that container's browser window.
   */
  | { kind: "reopen"; ids: NodeId[]; container?: NodeId | undefined }
  /** `TabTracker.closeNodes`: the live tabs of exactly these nodes close and save. */
  | { kind: "close"; ids: NodeId[] };

export interface HistoryEntry {
  /** Imperative, for tooltips: "Undo: delete 3 tabs". */
  label: string;
  /** Past tense, for the toast after the action: "Deleted 3 tabs". */
  done: string;
  undo: HistoryStep[];
  redo: HistoryStep[];
  ts: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const quote = (node: TreeNode) => {
  const title = displayTitle(node);
  return `"${title.length > 40 ? `${title.slice(0, 39)}…` : title}"`;
};

/** A node as it is re-added: same id and place, but saved (its browser tab is gone). */
export function asSaved(node: TreeNode): TreeNode {
  const copy = { ...node };
  delete copy.liveTabId;
  delete copy.liveWindowId;
  return copy;
}

/** Index of `node` among its siblings in `tree`, or its stored order when it is not there. */
function siblingIndex(tree: Tree, node: TreeNode): number {
  const i = tree.has(node.id)
    ? childrenOf(tree, node.parentId).findIndex((s) => s.id === node.id)
    : -1;
  return i >= 0 ? i : node.order;
}

/**
 * Ops that put `removed` back where they were. `removed` must list parents before children (as
 * `TabTracker.deleteNode` / `moveNode` return them); roots are inserted at the index they had
 * in `before`, descendants are appended in order under their re-added parents.
 */
export function readdOps(before: Tree, removed: readonly TreeNode[]): OpBody[] {
  const set = new Set(removed.map((n) => n.id));
  return removed.map((n) =>
    n.parentId !== null && set.has(n.parentId)
      ? ops.add(asSaved(n))
      : ops.add(asSaved(n), siblingIndex(before, n)),
  );
}

/**
 * Inverse of a batch applied to `before`, as ops that turn the resulting tree back into `before`.
 * Handles every op kind; removed subtrees come back saved.
 */
export function inverseOps(before: Tree, applied: readonly OpBody[]): OpBody[] {
  const inverses: OpBody[][] = [];
  let tree = before;
  for (const op of applied) {
    switch (op.type) {
      case "add":
        inverses.push([ops.remove(op.node.id)]);
        break;
      case "update": {
        const cur = tree.get(op.id);
        if (!cur) break;
        const patch: NodePatch = {};
        for (const key of Object.keys(op.patch) as (keyof NodePatch)[]) {
          const old = cur[key];
          (patch as Record<string, unknown>)[key] = old === undefined ? null : old;
        }
        inverses.push([ops.update(op.id, patch)]);
        break;
      }
      case "move": {
        const cur = tree.get(op.id);
        if (!cur) break;
        inverses.push([ops.move(op.id, cur.parentId, siblingIndex(tree, cur))]);
        break;
      }
      case "remove": {
        const root = tree.get(op.id);
        if (!root) break;
        const subtree = [root, ...descendantIds(tree, op.id).map((id) => tree.get(id) as TreeNode)];
        inverses.push(readdOps(tree, subtree));
        break;
      }
    }
    tree = applyForInverse(tree, op);
  }
  return inverses.reverse().flat();
}

/** Advance the working tree past `op` so the next inverse sees the right state; skip bad ops. */
function applyForInverse(tree: Tree, op: OpBody): Tree {
  try {
    return applyOp(tree, op, 0);
  } catch {
    return tree;
  }
}

/** Tab nodes at or beneath `id` that are open (`liveTabId` set), in depth-first order. */
export function liveTabNodesIn(tree: Tree, id: NodeId): TreeNode[] {
  const out: TreeNode[] = [];
  const self = tree.get(id);
  if (!self) return out;
  for (const n of [self, ...descendantIds(tree, id).map((d) => tree.get(d) as TreeNode)]) {
    if (n.kind === "tab" && n.liveTabId !== undefined) out.push(n);
  }
  return out;
}

/**
 * Saved tab nodes with a url at or beneath `id` (the ones restoring a tab or note opens). For a
 * container use `containerTabs`: its Reopen all leaves nested containers alone.
 */
export function savedTabNodesIn(tree: Tree, id: NodeId): TreeNode[] {
  const out: TreeNode[] = [];
  const self = tree.get(id);
  if (!self) return out;
  for (const n of [self, ...descendantIds(tree, id).map((d) => tree.get(d) as TreeNode)]) {
    if (n.kind === "tab" && n.liveTabId === undefined && n.url) out.push(n);
  }
  return out;
}

function describeRemoved(removed: readonly TreeNode[], rootId: NodeId): string {
  const root = removed.find((n) => n.id === rootId) ?? removed[0];
  const tabs = removed.filter((n) => n.kind === "tab").length;
  if (!root) return "delete";
  if (root.kind === "tab") {
    return tabs === 1 ? `delete ${quote(root)}` : `delete ${plural(tabs, "tab")}`;
  }
  const what = root.kind === "note" ? "note" : quote(root);
  return tabs ? `delete ${what} (${plural(tabs, "tab")})` : `delete ${what}`;
}

const past = (label: string) =>
  label
    .replace(/^delete/, "Deleted")
    .replace(/^move/, "Moved")
    .replace(/^close/, "Closed and saved")
    .replace(/^reopen/, "Reopened")
    .replace(/^rename/, "Renamed")
    .replace(/^edit note/, "Edited note")
    .replace(/^new/, "Added new");

/**
 * Entry builders. Each takes the tree *as the panel saw it before the action* (plus whatever the
 * background reported) and returns `null` when there is nothing to undo.
 */
export const history = {
  rename(before: Tree, id: NodeId, title: string, ts = Date.now()): HistoryEntry | null {
    const node = before.get(id);
    if (!node || node.title === title) return null;
    const label = `rename ${quote(node)}`;
    return {
      label,
      done: past(label),
      undo: [{ kind: "ops", ops: [ops.update(id, { title: node.title })] }],
      redo: [{ kind: "ops", ops: [ops.update(id, { title })] }],
      ts,
    };
  },

  note(before: Tree, id: NodeId, note: string, ts = Date.now()): HistoryEntry | null {
    const node = before.get(id);
    if (!node) return null;
    const text = note.trim();
    const old = (node.note ?? "").trim();
    if (text === old) return null;
    const label = `edit note on ${quote(node)}`;
    return {
      label,
      done: past(label),
      undo: [{ kind: "ops", ops: [ops.note(id, old)] }],
      redo: [{ kind: "ops", ops: [ops.note(id, text)] }],
      ts,
    };
  },

  /** A group (unbound container) or note the user just created (response of `addNode`). */
  create(node: TreeNode, index: number | undefined, ts = Date.now()): HistoryEntry {
    const label = `new ${node.kind === "window" ? "group" : node.kind}`;
    return {
      label,
      done: past(label),
      undo: [{ kind: "removeEmpty", id: node.id }],
      redo: [{ kind: "ops", ops: [ops.add(node, index)] }],
      ts,
    };
  },

  /** A drag / drop. `pruned` is what `moveNode` returned: windows emptied by the move. */
  move(
    before: Tree,
    id: NodeId,
    parentId: NodeId | null,
    index: number,
    pruned: readonly TreeNode[] = [],
    ts = Date.now(),
  ): HistoryEntry | null {
    const node = before.get(id);
    if (!node) return null;
    const undo: HistoryStep[] = [];
    if (pruned.length) undo.push({ kind: "ops", ops: readdOps(before, pruned) });
    undo.push({ kind: "move", id, parentId: node.parentId, index: siblingIndex(before, node) });
    const label = `move ${quote(node)}`;
    return {
      label,
      done: past(label),
      undo,
      redo: [{ kind: "move", id, parentId, index }],
      ts,
    };
  },

  /** A delete. `removed` is what `deleteNode` returned: subtree plus pruned windows, parents first. */
  remove(
    before: Tree,
    removed: readonly TreeNode[],
    rootId: NodeId,
    ts = Date.now(),
  ): HistoryEntry | null {
    if (!removed.length) return null;
    const label = describeRemoved(removed, rootId);
    return {
      label,
      done: past(label),
      undo: [{ kind: "ops", ops: readdOps(before, removed) }],
      redo: [{ kind: "delete", id: rootId }],
      ts,
    };
  },

  /**
   * Close-and-save on a tab or container: the open tabs beneath it become saved in place. Closing
   * a bound container closes its browser window, so the undo brings that window back as one.
   */
  closeAndSave(before: Tree, id: NodeId, ts = Date.now()): HistoryEntry | null {
    const nodes = liveTabNodesIn(before, id);
    if (!nodes.length) return null;
    const ids = nodes.map((n) => n.id);
    const root = before.get(id);
    const label =
      nodes.length === 1 && root?.kind === "tab"
        ? `close ${quote(root)}`
        : `close ${plural(nodes.length, "tab")}`;
    const reopen: HistoryStep =
      root && isBound(root) ? { kind: "reopen", ids, container: id } : { kind: "reopen", ids };
    return {
      label,
      done: past(label),
      undo: [reopen],
      redo: [{ kind: "close", ids }],
      ts,
    };
  },

  /**
   * Restore / Reopen all on a saved node: its saved tabs open in place. On an unbound container
   * that means opening it as a browser window; the redo does the same, the undo closes those
   * tabs again (and with them the window).
   */
  reopen(before: Tree, id: NodeId, ts = Date.now()): HistoryEntry | null {
    const root = before.get(id);
    const nodes =
      root && isContainer(root)
        ? containerTabs(before, id).filter((n) => n.liveTabId === undefined && n.url)
        : savedTabNodesIn(before, id);
    if (!nodes.length) return null;
    const ids = nodes.map((n) => n.id);
    const label =
      nodes.length === 1 && root?.kind === "tab"
        ? `reopen ${quote(root)}`
        : `reopen ${plural(nodes.length, "tab")}`;
    const redo: HistoryStep =
      root && isContainer(root) && !isBound(root)
        ? { kind: "reopen", ids, container: id }
        : { kind: "reopen", ids };
    return {
      label,
      done: past(label),
      undo: [{ kind: "close", ids }],
      redo: [redo],
      ts,
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Stack

export interface HistoryState {
  undo: HistoryEntry[];
  redo: HistoryEntry[];
}

/**
 * Two bounded stacks. Undoing pops from `undo` and, once its steps ran, pushes onto `redo`; a new
 * entry clears `redo`. The class holds no browser state; the panel persists `toJSON()`.
 */
export class HistoryStack {
  private undoStack: HistoryEntry[];
  private redoStack: HistoryEntry[];

  constructor(
    state: HistoryState = { undo: [], redo: [] },
    private readonly depth = HISTORY_DEPTH,
  ) {
    this.undoStack = state.undo.slice(-depth);
    this.redoStack = state.redo.slice(-depth);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  peekUndo(): HistoryEntry | undefined {
    return this.undoStack[this.undoStack.length - 1];
  }

  peekRedo(): HistoryEntry | undefined {
    return this.redoStack[this.redoStack.length - 1];
  }

  get size(): number {
    return this.undoStack.length;
  }

  push(entry: HistoryEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.depth)
      this.undoStack.splice(0, this.undoStack.length - this.depth);
    this.redoStack = [];
  }

  /** Take the next entry to undo off the stack; call `undone` once its steps succeeded. */
  takeUndo(): HistoryEntry | undefined {
    return this.undoStack.pop();
  }

  undone(entry: HistoryEntry): void {
    this.redoStack.push(entry);
    if (this.redoStack.length > this.depth)
      this.redoStack.splice(0, this.redoStack.length - this.depth);
  }

  takeRedo(): HistoryEntry | undefined {
    return this.redoStack.pop();
  }

  redone(entry: HistoryEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.depth)
      this.undoStack.splice(0, this.undoStack.length - this.depth);
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  toJSON(): HistoryState {
    return { undo: [...this.undoStack], redo: [...this.redoStack] };
  }

  /** Rebuild from persisted state; anything malformed is dropped rather than trusted. */
  static fromJSON(value: unknown, depth = HISTORY_DEPTH): HistoryStack {
    const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    const entries = (list: unknown): HistoryEntry[] =>
      Array.isArray(list) ? list.map(coerceEntry).filter((e): e is HistoryEntry => !!e) : [];
    return new HistoryStack({ undo: entries(v.undo), redo: entries(v.redo) }, depth);
  }
}

const STEP_KINDS = new Set(["ops", "removeEmpty", "move", "delete", "reopen", "close"]);

function coerceStep(value: unknown): HistoryStep | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.kind !== "string" || !STEP_KINDS.has(v.kind)) return undefined;
  switch (v.kind) {
    case "ops":
      return Array.isArray(v.ops) ? { kind: "ops", ops: v.ops as OpBody[] } : undefined;
    case "removeEmpty":
    case "delete":
      return typeof v.id === "string" ? { kind: v.kind, id: v.id } : undefined;
    case "move":
      return typeof v.id === "string" &&
        (v.parentId === null || typeof v.parentId === "string") &&
        typeof v.index === "number"
        ? { kind: "move", id: v.id, parentId: v.parentId as NodeId | null, index: v.index }
        : undefined;
    case "reopen":
      if (!Array.isArray(v.ids) || !v.ids.every((i) => typeof i === "string")) return undefined;
      return typeof v.container === "string"
        ? { kind: "reopen", ids: v.ids as NodeId[], container: v.container }
        : { kind: "reopen", ids: v.ids as NodeId[] };
    case "close":
      return Array.isArray(v.ids) && v.ids.every((i) => typeof i === "string")
        ? { kind: "close", ids: v.ids as NodeId[] }
        : undefined;
    default:
      return undefined;
  }
}

function coerceEntry(value: unknown): HistoryEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.label !== "string" || !Array.isArray(v.undo) || !Array.isArray(v.redo)) {
    return undefined;
  }
  const undo = v.undo.map(coerceStep);
  const redo = v.redo.map(coerceStep);
  if (undo.some((s) => !s) || redo.some((s) => !s)) return undefined;
  return {
    label: v.label,
    done: typeof v.done === "string" ? v.done : v.label,
    undo: undo as HistoryStep[],
    redo: redo as HistoryStep[],
    ts: typeof v.ts === "number" ? v.ts : 0,
  };
}

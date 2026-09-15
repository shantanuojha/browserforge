/**
 * What an undo/redo entry is made of, and how a persisted one is read back. Entries are
 * self-contained: they carry the nodes they re-add and the ids they act on, never op sequence
 * numbers, so log compaction cannot make them unreplayable.
 */
import type { NodeId, OpBody } from "../model";

/** One thing the background does on behalf of an undo or redo. */
export type HistoryStep =
  /** Plain tree edits: updates, and adds that put removed nodes back (same ids, saved). */
  | { kind: "ops"; ops: OpBody[] }
  /** Remove a node the user created, but only while it is still empty. */
  | { kind: "removeEmpty"; id: NodeId }
  /** `TabTracker.moveNode`: the browser tab follows when it has to. */
  | { kind: "move"; id: NodeId; parentId: NodeId | null; index: number }
  /** `TabTracker.removeNode`: tree-only subtree removal; open tabs stay open, re-mirrored. */
  | { kind: "remove"; id: NodeId }
  /** `TabTracker.closeAndRemove`: closes the open tabs beneath the node, then removes the subtree. */
  | { kind: "closeAndRemove"; id: NodeId }
  /**
   * `TabTracker.reopenNodes`: these saved nodes become live in place. With `container` (the
   * container the action was run on: a window closed as a whole, a group reopened as a window)
   * they come back together as that container's browser window.
   */
  | { kind: "reopen"; ids: NodeId[]; container?: NodeId | undefined }
  /** `TabTracker.closeNodes`: the live tabs of exactly these nodes close and save. */
  | { kind: "close"; ids: NodeId[] };

export type HistoryStepKind = HistoryStep["kind"];

/** The step of one kind, for handler tables keyed by `kind`. */
export type StepOf<K extends HistoryStepKind> = Extract<HistoryStep, { kind: K }>;

export interface HistoryEntry {
  /** Imperative, for tooltips: "Undo: delete 3 tabs". */
  label: string;
  /** Past tense, for the toast after the action: "Deleted 3 tabs". */
  done: string;
  undo: HistoryStep[];
  redo: HistoryStep[];
  ts: number;
}

type Raw = Record<string, unknown>;

const isIdList = (value: unknown): value is NodeId[] =>
  Array.isArray(value) && value.every((i) => typeof i === "string");

const isParentId = (value: unknown): value is NodeId | null =>
  value === null || typeof value === "string";

type StepCoercer<K extends HistoryStepKind> = (v: Raw) => StepOf<K> | undefined;

const STEP_COERCERS: { [K in HistoryStepKind]: StepCoercer<K> } = {
  ops: (v) => (Array.isArray(v.ops) ? { kind: "ops", ops: v.ops as OpBody[] } : undefined),
  removeEmpty: (v) => (typeof v.id === "string" ? { kind: "removeEmpty", id: v.id } : undefined),
  remove: (v) => (typeof v.id === "string" ? { kind: "remove", id: v.id } : undefined),
  closeAndRemove: (v) =>
    typeof v.id === "string" ? { kind: "closeAndRemove", id: v.id } : undefined,
  move: (v) =>
    typeof v.id === "string" && isParentId(v.parentId) && typeof v.index === "number"
      ? { kind: "move", id: v.id, parentId: v.parentId, index: v.index }
      : undefined,
  reopen: (v) => {
    if (!isIdList(v.ids)) return undefined;
    return typeof v.container === "string"
      ? { kind: "reopen", ids: v.ids, container: v.container }
      : { kind: "reopen", ids: v.ids };
  },
  close: (v) => (isIdList(v.ids) ? { kind: "close", ids: v.ids } : undefined),
};

function isStepKind(value: unknown): value is HistoryStepKind {
  return typeof value === "string" && Object.hasOwn(STEP_COERCERS, value);
}

export function coerceStep(value: unknown): HistoryStep | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Raw;
  if (!isStepKind(v.kind)) return undefined;
  return (STEP_COERCERS[v.kind] as StepCoercer<HistoryStepKind>)(v);
}

export function coerceEntry(value: unknown): HistoryEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Raw;
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

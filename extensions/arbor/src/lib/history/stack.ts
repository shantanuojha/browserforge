/**
 * Two bounded stacks. Undoing pops from `undo` and, once its steps ran, pushes onto `redo`; a new
 * entry clears `redo`. The class holds no browser state; the panel persists `toJSON()`.
 */
import { coerceEntry, type HistoryEntry } from "./steps";

export const HISTORY_DEPTH = 50;

export interface HistoryState {
  undo: HistoryEntry[];
  redo: HistoryEntry[];
}

/** Push onto a bounded stack, dropping the oldest entries past `depth`. */
function pushBounded(stack: HistoryEntry[], entry: HistoryEntry, depth: number): void {
  stack.push(entry);
  if (stack.length > depth) stack.splice(0, stack.length - depth);
}

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
    pushBounded(this.undoStack, entry, this.depth);
    this.redoStack = [];
  }

  /** Take the next entry to undo off the stack; call `undone` once its steps succeeded. */
  takeUndo(): HistoryEntry | undefined {
    return this.undoStack.pop();
  }

  undone(entry: HistoryEntry): void {
    pushBounded(this.redoStack, entry, this.depth);
  }

  takeRedo(): HistoryEntry | undefined {
    return this.redoStack.pop();
  }

  redone(entry: HistoryEntry): void {
    pushBounded(this.undoStack, entry, this.depth);
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

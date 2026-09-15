/**
 * Undo / redo for user-initiated tree edits in the side panel.
 *
 * There is no second history mechanism. An undo is the *inverse* of what an action did, expressed
 * as ordinary ops appended to the same op log (or as the same tracker call a user gesture makes,
 * when live tabs are involved): re-adding a deleted subtree is a batch of `add` ops with the
 * original ids; undoing a move is a move back; undoing close-and-save reopens the very same nodes
 * in place; undoing a reopen closes exactly those tabs again; undoing a remove-from-tree re-adds
 * what went and moves the open tabs it kept back where they were. The panel keeps a short stack
 * of such entries for its session.
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
 * of the mutating message; the background runs steps (`lib/sync/history-runner.ts`).
 */
export {
  coerceEntry,
  coerceStep,
  type HistoryEntry,
  type HistoryStep,
  type HistoryStepKind,
  type StepOf,
} from "./steps";
export {
  asSaved,
  inverseOps,
  liveTabNodesIn,
  readdOps,
  savedTabNodesIn,
  siblingIndex,
  unremoveOps,
} from "./inverse";
export { createHistory, type HistoryBuilders, type MoveRequest } from "./entries";
export { HISTORY_DEPTH, HistoryStack, type HistoryState } from "./stack";

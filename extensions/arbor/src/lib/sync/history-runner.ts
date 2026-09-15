/**
 * Runs one undo/redo step (see `lib/history`). Every kind maps onto the same code a user
 * gesture would run, so live tabs are handled identically; steps that no longer apply throw with
 * a message the panel shows. Adding a step kind means adding one entry to `RUNNERS`.
 */
import type { HistoryStep, HistoryStepKind, StepOf } from "../history";
import { childrenOf, displayTitle, ops, type NodeId, type Tree, type TreeNode } from "../model";
import type { OpBody } from "../model";

/** What a step needs from the tracker. */
export interface StepTarget {
  readonly tree: Tree;
  append(bodies: readonly OpBody[]): void;
  moveNode(id: NodeId, parentId: NodeId | null, index: number): Promise<TreeNode[]>;
  removeNode(id: NodeId): TreeNode[];
  closeAndRemove(id: NodeId): Promise<TreeNode[]>;
  reopenNodes(ids: readonly NodeId[], container?: NodeId): Promise<number>;
  closeNodes(ids: readonly NodeId[]): Promise<number>;
}

type StepRunner<K extends HistoryStepKind> = (
  target: StepTarget,
  step: StepOf<K>,
) => Promise<void> | void;

const RUNNERS: { [K in HistoryStepKind]: StepRunner<K> } = {
  ops(target, step) {
    target.append(step.ops);
  },
  removeEmpty(target, step) {
    const node = target.tree.get(step.id);
    if (!node) return;
    if (childrenOf(target.tree, step.id).length) {
      throw new Error(`"${displayTitle(node)}" is no longer empty, so it was not removed`);
    }
    target.append([ops.remove(step.id)]);
  },
  async move(target, step) {
    if (!target.tree.has(step.id)) throw new Error("That node no longer exists");
    await target.moveNode(step.id, step.parentId, step.index);
  },
  remove(target, step) {
    target.removeNode(step.id);
  },
  async closeAndRemove(target, step) {
    await target.closeAndRemove(step.id);
  },
  async reopen(target, step) {
    await target.reopenNodes(step.ids, step.container);
  },
  async close(target, step) {
    await target.closeNodes(step.ids);
  },
};

export async function runHistoryStep(target: StepTarget, step: HistoryStep): Promise<void> {
  await (RUNNERS[step.kind] as StepRunner<HistoryStepKind>)(target, step);
}

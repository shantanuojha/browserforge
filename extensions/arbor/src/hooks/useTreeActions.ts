import { useCallback, useMemo } from "react";
import { msg } from "@/adapters/messaging";
import type { TreeActions } from "@/components/TreeView";
import type { HistoryBuilders, HistoryEntry } from "@/lib/history";
import { ops, type NodeId, type OpBody, type Tree } from "@/lib/model";
import { plural } from "@/lib/panel-text";
import { primaryActionFor } from "@/lib/primary-action";
import { canCloseAndRemove, canRemove, summarizeRemoval } from "@/lib/removal";
import type { Toast } from "./useToast";

export interface TreeActionDeps {
  tree: Tree;
  history: HistoryBuilders;
  /** Record an undo entry (`null` means nothing to undo). */
  push(entry: HistoryEntry | null): void;
  report(error: unknown): void;
  notify(toast: Toast): void;
  /** Ask before closing tabs without saving them ("Close tabs and remove"). */
  confirmCloseAndRemove(id: NodeId): void;
}

export interface TreeActionsApi {
  actions: TreeActions;
  /** Close and remove without asking; the confirmation dialog calls this once the user agreed. */
  performCloseAndRemove(id: NodeId): void;
}

interface ActionContext extends TreeActionDeps {
  /** Fire and forget: failures become a toast. */
  run(p: Promise<unknown>): void;
}

/** Edits that only touch the tree: notes, titles, collapse, new nodes, drag-and-drop, remove. */
function treeEdits(
  ctx: ActionContext,
): Pick<
  TreeActions,
  "toggleCollapse" | "setNote" | "rename" | "move" | "addGroup" | "addNote" | "removeNode"
> {
  const { tree, history, push, notify, run } = ctx;
  /** Apply one op, then record the entry built from the tree before it. */
  const edit = (entry: HistoryEntry | null, body: OpBody) =>
    run(msg.applyOps.send([body]).then(() => push(entry)));
  const add = (input: Parameters<typeof msg.addNode.send>[0]) =>
    run(msg.addNode.send(input).then((node) => push(history.create(node, input.index))));
  return {
    toggleCollapse: (id, collapsed) => run(msg.applyOps.send([ops.collapse(id, collapsed)])),
    setNote: (id, note) => edit(history.note(tree, id, note), ops.note(id, note)),
    rename: (id, title) => edit(history.rename(tree, id, title), ops.update(id, { title })),
    move: (id, parentId, index) =>
      run(
        msg.moveNode
          .send({ id, parentId, index })
          .then((pruned) => push(history.move(tree, { id, parentId, index }, pruned))),
      ),
    // A group is a closed container with a name: the same node kind as a window.
    addGroup: (parentId, index) => add({ parentId, index, kind: "window", title: "New group" }),
    addNote: (parentId, index) => add({ parentId, index, kind: "note", title: "Note" }),
    // Never touches the browser, always undoable: no confirmation, the toast offers Undo.
    removeNode: (id) => {
      const node = tree.get(id);
      if (!node || !canRemove(summarizeRemoval(tree, node))) return;
      run(
        msg.removeNode.send({ id }).then((removed) => {
          const entry = history.remove(tree, removed, id);
          push(entry);
          if (entry) notify({ text: `${entry.done}.`, undo: true });
        }),
      );
    },
  };
}

/** Actions that reach the browser: focus, restore, reopen, close-and-save, close-and-remove. */
function liveActions(
  ctx: ActionContext,
): Pick<TreeActions, "primary" | "restore" | "reopenAll" | "closeAndSave" | "closeAndRemove"> {
  const { tree, history, push, notify, run } = ctx;
  const reopen = (id: NodeId) => {
    const entry = history.reopen(tree, id);
    run(msg.restoreNode.send({ id }).then(() => push(entry)));
  };
  return {
    primary: (id) => {
      const n = tree.get(id);
      if (!n) return;
      if (primaryActionFor(n) === "focus") run(msg.focusNode.send({ id }));
      else reopen(id);
    },
    restore: reopen,
    reopenAll: (id) => {
      const entry = history.reopen(tree, id);
      run(
        msg.reopenAll.send({ id }).then((n) => {
          push(entry);
          if (n) notify({ text: `Reopened ${plural(n, "tab")}.`, undo: !!entry });
          else notify({ text: "Nothing to reopen." });
        }),
      );
    },
    closeAndSave: (id) => {
      const entry = history.closeAndSave(tree, id);
      run(
        msg.closeAndSave.send({ id }).then((n) => {
          push(entry);
          if (n) notify({ text: `Closed and saved ${plural(n, "tab")}.`, undo: !!entry });
        }),
      );
    },
    // The one action that closes tabs without saving them: it always asks first.
    closeAndRemove: (id) => {
      const node = tree.get(id);
      if (!node || !canCloseAndRemove(summarizeRemoval(tree, node))) return;
      ctx.confirmCloseAndRemove(id);
    },
  };
}

/**
 * The panel's side of every tree edit: send the message, then record the inverse against the
 * tree the panel showed at the time (`tree`), so `actions` is rebuilt per tree version.
 * Collapse/expand is not recorded.
 */
export function useTreeActions(deps: TreeActionDeps): TreeActionsApi {
  const { tree, history, push, report, notify, confirmCloseAndRemove } = deps;

  const performCloseAndRemove = useCallback(
    (id: NodeId) => {
      void msg.closeAndRemove.send({ id }).then((removed) => {
        const entry = history.closeAndRemove(tree, removed, id);
        push(entry);
        if (entry) notify({ text: `${entry.done}.`, undo: true });
      }, report);
    },
    [tree, history, push, report, notify],
  );

  const actions = useMemo<TreeActions>(() => {
    const ctx: ActionContext = {
      tree,
      history,
      push,
      report,
      notify,
      confirmCloseAndRemove,
      run: (p) => void p.catch(report),
    };
    return { ...treeEdits(ctx), ...liveActions(ctx) };
  }, [tree, history, push, report, notify, confirmCloseAndRemove]);

  return { actions, performCloseAndRemove };
}

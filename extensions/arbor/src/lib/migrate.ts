/**
 * Normalisation of trees written by older versions. Runs on every rebuild, is idempotent (a tree
 * already in shape yields no ops) and is logged as ordinary ops, so it replays like any other
 * change and shows up in Recovery snapshots.
 *
 * What is (and is not) done here:
 * - The pre-0.1.4 `group` kind is not touched by this module: `coerceNode` reads it as `window`
 *   wherever it appears (snapshots, the op log, backups, exports), so no node in memory ever
 *   carries it. Once the store compacts, the snapshot is written with the new kind.
 * - Containers the browser opened used to be titled "Window". They now carry an empty title, which
 *   the UI shows as "Window"; the empty title is what marks a container as auto-created, and only
 *   those are pruned when they end up empty and closed. Groups the user named are never pruned.
 */

import { DEFAULT_WINDOW_TITLE, ops, type OpBody, type Tree } from "./model";

export function migrationOps(tree: Tree): OpBody[] {
  const out: OpBody[] = [];
  for (const n of tree.values()) {
    if (n.kind === "window" && n.title === DEFAULT_WINDOW_TITLE) {
      out.push(ops.update(n.id, { title: "" }));
    }
  }
  return out;
}

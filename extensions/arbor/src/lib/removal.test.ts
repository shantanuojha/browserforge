import { describe, expect, it } from "vitest";
import { createTree, makeNode, type NodeId, type TreeNode } from "./model";
import {
  canCloseAndRemove,
  canRemove,
  closeAndRemoveLabel,
  removeLabel,
  summarizeRemoval,
} from "./removal";

function node(
  id: NodeId,
  parentId: NodeId | null,
  kind: TreeNode["kind"],
  extra: Partial<TreeNode> = {},
): TreeNode {
  return { ...makeNode({ id, parentId, kind, title: id, ts: 1 }), ...extra };
}
const tab = (id: NodeId, parentId: NodeId, live?: number, extra: Partial<TreeNode> = {}) =>
  node(id, parentId, "tab", {
    url: `https://${id}.test/`,
    ...(live !== undefined ? { liveTabId: live, liveWindowId: 1 } : {}),
    ...extra,
  });
const openWindow = (id: NodeId, win = 1, extra: Partial<TreeNode> = {}) =>
  node(id, null, "window", { title: "", liveWindowId: win, ...extra });

const summary = (tree: ReturnType<typeof createTree>, id: NodeId) =>
  summarizeRemoval(tree, tree.get(id) as TreeNode);

describe("summarizeRemoval", () => {
  it("a group: itself and its saved items go, open tabs are kept (and moved home), nested open windows stay", () => {
    const tree = createTree([
      openWindow("w"),
      tab("a", "w", 10),
      node("g", null, "window"),
      tab("s", "g"),
      tab("l", "g", 11), // open in W, filed in the group
      node("memo", "g", "note"),
      node("inner", "g", "window", { liveWindowId: 2 }), // an open window nested in the group
      tab("deep", "inner", 20, { liveWindowId: 2 }),
    ]);
    expect(summary(tree, "g")).toEqual({ liveTabs: 2, removed: 3, reset: 2, stays: false });
    expect(canRemove(summary(tree, "g"))).toBe(true);
    expect(canCloseAndRemove(summary(tree, "g"))).toBe(true);
    expect(removeLabel(summary(tree, "g"), tree.get("g") as TreeNode)).toBe(
      "Remove from tree (keeps 2 open tabs)",
    );
    expect(closeAndRemoveLabel(summary(tree, "g"))).toBe("Close tabs and remove (2 open tabs)");
  });

  it("an open window with plain open tabs in place: nothing to remove, tabs to close", () => {
    const tree = createTree([openWindow("w"), tab("a", "w", 10), tab("b", "a", 11)]);
    const s = summary(tree, "w");
    expect(s).toEqual({ liveTabs: 2, removed: 0, reset: 0, stays: true });
    expect(canRemove(s)).toBe(false);
    expect(canCloseAndRemove(s)).toBe(true);
    expect(removeLabel(s, tree.get("w") as TreeNode)).toBe("Remove saved items");
  });

  it("an open window with a title, a note, a saved tab or a tab from elsewhere: something to remove", () => {
    expect(canRemove(summary(createTree([openWindow("w", 1, { title: "Work" })]), "w"))).toBe(true);
    expect(canRemove(summary(createTree([openWindow("w", 1, { note: "n" })]), "w"))).toBe(true);
    expect(canRemove(summary(createTree([openWindow("w"), tab("s", "w")]), "w"))).toBe(true);
    const elsewhere = createTree([
      openWindow("w"),
      openWindow("w2", 2),
      tab("x", "w", 30, { liveWindowId: 2 }),
    ]);
    expect(summary(elsewhere, "w")).toEqual({ liveTabs: 1, removed: 0, reset: 1, stays: true });
    // A note on an open tab beneath is dropped by the action, so it counts too.
    const noted = createTree([openWindow("w"), tab("a", "w", 10, { note: "todo" })]);
    expect(summary(noted, "w").reset).toBe(1);
  });

  it("an open tab: bare and in place there is nothing to do; filed away, noted or with a subtree there is", () => {
    const tree = createTree([
      openWindow("w"),
      tab("a", "w", 10),
      tab("b", "w", 11, { note: "n" }),
      node("g", null, "window"),
      tab("c", "g", 12),
      tab("d", "w", 13),
      tab("s", "d"),
    ]);
    expect(summary(tree, "a")).toEqual({ liveTabs: 1, removed: 0, reset: 0, stays: true });
    expect(canRemove(summary(tree, "a"))).toBe(false);
    expect(canRemove(summary(tree, "b"))).toBe(true); // note to drop
    expect(canRemove(summary(tree, "c"))).toBe(true); // goes back under W
    expect(summary(tree, "d")).toEqual({ liveTabs: 1, removed: 1, reset: 0, stays: true });
    expect(removeLabel(summary(tree, "d"), tree.get("d") as TreeNode)).toBe(
      "Remove from tree (keeps 1 open tab)",
    );
    expect(closeAndRemoveLabel(summary(tree, "a"))).toBe("Close tabs and remove (1 open tab)");
  });

  it("a saved tab or a note: always removable; close-and-remove only with open tabs beneath", () => {
    const tree = createTree([
      node("g", null, "window"),
      tab("s", "g"),
      node("memo", "g", "note"),
      tab("l", "memo", 20),
    ]);
    expect(summary(tree, "s")).toEqual({ liveTabs: 0, removed: 1, reset: 0, stays: false });
    expect(canCloseAndRemove(summary(tree, "s"))).toBe(false);
    expect(closeAndRemoveLabel(summary(tree, "s"))).toBe("Close tabs and remove");
    expect(summary(tree, "memo")).toEqual({ liveTabs: 1, removed: 1, reset: 1, stays: false });
    expect(canCloseAndRemove(summary(tree, "memo"))).toBe(true);
    expect(removeLabel(summary(tree, "s"), tree.get("s") as TreeNode)).toBe("Remove from tree");
  });
});

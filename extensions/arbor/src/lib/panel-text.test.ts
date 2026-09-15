import { describe, expect, it } from "vitest";
import { createTree, makeNode, type NodeId, type TreeNode } from "./model";
import { closeAndRemoveWarning } from "./panel-text";

function node(
  id: NodeId,
  parentId: NodeId | null,
  kind: TreeNode["kind"],
  extra: Partial<TreeNode> = {},
): TreeNode {
  return { ...makeNode({ id, parentId, kind, title: id, ts: 1 }), ...extra };
}
const tab = (id: NodeId, parentId: NodeId, live?: number) =>
  node(id, parentId, "tab", {
    url: `https://${id}.test/`,
    ...(live !== undefined ? { liveTabId: live, liveWindowId: 1 } : {}),
  });

describe("closeAndRemoveWarning", () => {
  it("says how many open tabs close unsaved and that the node and its saved items are deleted", () => {
    const tree = createTree([
      node("g", null, "window", { title: "Research" }),
      tab("a", "g", 10),
      tab("b", "g", 11),
      tab("s", "g"),
      node("memo", "g", "note"),
      node("w", null, "window", { title: "", liveWindowId: 1 }),
      tab("c", "w", 12),
    ]);
    expect(closeAndRemoveWarning(tree, "g")).toBe(
      '2 open tabs will be closed without being saved, and "Research" with its 2 saved items will be deleted from the tree. Earlier snapshots in Recovery still contain them.',
    );
    expect(closeAndRemoveWarning(tree, "c")).toBe(
      '1 open tab will be closed without being saved, and "c" will be deleted from the tree. Earlier snapshots in Recovery still contain them.',
    );
    expect(closeAndRemoveWarning(tree, "w")).toBe(
      '1 open tab will be closed without being saved, and "Window" will be deleted from the tree. Earlier snapshots in Recovery still contain them.',
    );
    expect(closeAndRemoveWarning(tree, "ghost")).toBe("");
  });
});

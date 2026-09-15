import { describe, expect, it } from "vitest";
import { containerActions, type ContainerNode } from "./container-actions";
import { buildChildIndex, createTree, makeNode, type NodeId, type TreeNode } from "./model";
import { buildContextMenu, type MenuHandlers, type MenuItem } from "./tree-menu";

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

function handlers(): MenuHandlers & { calls: string[] } {
  const calls: string[] = [];
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args].join(":"));
    };
  return {
    calls,
    primary: rec("primary"),
    closeAndSave: rec("closeAndSave"),
    restore: rec("restore"),
    removeNode: rec("removeNode"),
    closeAndRemove: rec("closeAndRemove"),
    toggleCollapse: rec("toggleCollapse"),
    editNote: rec("editNote"),
    startRename: rec("startRename"),
    addGroup: rec("addGroup"),
    addNote: rec("addNote"),
  };
}

/** The menu of `id`, with separators dropped, as `[label, shortcut, danger, disabled]` rows. */
function menuOf(tree: ReturnType<typeof createTree>, id: NodeId, h = handlers()) {
  const nodeAt = tree.get(id) as TreeNode;
  const containerH = {
    reopenAll: () => undefined,
    closeAndSave: h.closeAndSave,
    editNote: h.editNote,
    startRename: h.startRename,
    toggleCollapse: h.toggleCollapse,
    removeNode: h.removeNode,
    closeAndRemove: h.closeAndRemove,
  };
  const entries = buildContextMenu({
    tree,
    node: nodeAt,
    childIndex: buildChildIndex(tree),
    containerActions:
      nodeAt.kind === "window" ? containerActions(tree, nodeAt as ContainerNode, containerH) : null,
    handlers: h,
  });
  return entries.filter((e): e is MenuItem => e !== "separator");
}
const rows = (items: MenuItem[]) =>
  items.map((i) => [i.label, i.shortcut, i.danger ?? false, i.disabled ?? false]);

const fixture = () =>
  createTree([
    node("w", null, "window", { title: "", liveWindowId: 1 }),
    tab("a", "w", 10),
    tab("b", "w", 11, { note: "n" }),
    node("g", null, "window"),
    tab("s", "g"),
    tab("c", "s", 12), // open tab filed under a saved one
    node("memo", "g", "note"),
  ]);

describe("context menu: the two ways out of the tree", () => {
  it("an open tab ends with Remove (Delete) and the destructive Close tabs and remove (Shift+Delete)", () => {
    const h = handlers();
    const items = menuOf(fixture(), "b", h);
    expect(rows(items).slice(0, 2)).toEqual([
      ["Focus", "Enter", false, false],
      ["Close and save", undefined, false, false], // Delete no longer means this
    ]);
    expect(rows(items).slice(-2)).toEqual([
      ["Remove from tree (keeps 1 open tab)", "Del", false, false],
      ["Close tabs and remove (1 open tab)", "Shift+Del", true, false],
    ]);
    items[items.length - 2]?.onSelect();
    items[items.length - 1]?.onSelect();
    expect(h.calls).toEqual(["removeNode:b", "closeAndRemove:b"]);
  });

  it("a bare open tab in place: Remove is greyed out, Close tabs and remove is not", () => {
    expect(rows(menuOf(fixture(), "a")).slice(-2)).toEqual([
      ["Remove from tree (keeps 1 open tab)", "Del", false, true],
      ["Close tabs and remove (1 open tab)", "Shift+Del", true, false],
    ]);
  });

  it("a saved tab with an open tab beneath: both on; a note without one: only Remove", () => {
    expect(rows(menuOf(fixture(), "s")).slice(-2)).toEqual([
      ["Remove from tree (keeps 1 open tab)", "Del", false, false],
      ["Close tabs and remove (1 open tab)", "Shift+Del", true, false],
    ]);
    expect(rows(menuOf(fixture(), "memo")).slice(-2)).toEqual([
      ["Remove from tree", "Del", false, false],
      ["Close tabs and remove", "Shift+Del", true, true],
    ]);
  });

  it("containers render the same two entries from the shared definition", () => {
    const h = handlers();
    const group = menuOf(fixture(), "g", h);
    expect(rows(group).slice(-2)).toEqual([
      ["Remove from tree (keeps 1 open tab)", "Del", false, false],
      ["Close tabs and remove (1 open tab)", "Shift+Del", true, false],
    ]);
    const window = menuOf(fixture(), "w", h);
    expect(rows(window).slice(-2)).toEqual([
      ["Remove saved items", "Del", false, false], // B carries a note that would be dropped
      ["Close tabs and remove (2 open tabs)", "Shift+Del", true, false],
    ]);
    group[group.length - 1]?.onSelect();
    expect(h.calls).toEqual(["closeAndRemove:g"]);
  });
});

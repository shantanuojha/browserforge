import { describe, expect, it } from "vitest";
import {
  containerActions,
  deleteKeyAction,
  isContainer,
  summarizeContainer,
  type ContainerActionHandlers,
  type ContainerNode,
} from "./container-actions";
import { createTree, makeNode, type NodeId, type TreeNode } from "./model";

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

function handlers(): ContainerActionHandlers & { calls: string[] } {
  const calls: string[] = [];
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args].join(":"));
    };
  return {
    calls,
    reopenAll: rec("reopenAll"),
    closeAndSave: rec("closeAndSave"),
    editNote: rec("editNote"),
    startRename: rec("startRename"),
    toggleCollapse: rec("toggleCollapse"),
    deleteNode: rec("deleteNode"),
  };
}

const enabledIds = (tree: ReturnType<typeof createTree>, c: TreeNode) =>
  containerActions(tree, c as ContainerNode, handlers())
    .filter((a) => !a.disabled)
    .map((a) => a.id);

const ALL = ["reopen", "closeAndSave", "note", "rename", "collapse", "delete"];

describe("container actions", () => {
  it("windows and groups are containers, tabs and notes are not", () => {
    expect(isContainer(node("w", null, "window"))).toBe(true);
    expect(isContainer(node("g", null, "group"))).toBe(true);
    expect(isContainer(node("t", null, "tab"))).toBe(false);
    expect(isContainer(node("n", null, "note"))).toBe(false);
  });

  it("offers the same action set, in the same order, for a window and a group", () => {
    const tree = createTree([node("w", null, "window"), node("g", null, "group")]);
    const h = handlers();
    const win = containerActions(tree, tree.get("w") as ContainerNode, h);
    const grp = containerActions(tree, tree.get("g") as ContainerNode, h);
    expect(win.map((a) => a.id)).toEqual(ALL);
    expect(grp.map((a) => a.id)).toEqual(ALL);
    expect(win.map((a) => [a.icon, a.section, a.inRow])).toEqual(
      grp.map((a) => [a.icon, a.section, a.inRow]),
    );
  });

  it("live window: close-and-save on, reopen off while nothing beneath it is saved", () => {
    const tree = createTree([
      node("w", null, "window", { liveWindowId: 1 }),
      tab("a", "w", 10),
      tab("b", "w", 11),
    ]);
    const acts = containerActions(tree, tree.get("w") as ContainerNode, handlers());
    expect(enabledIds(tree, tree.get("w") as TreeNode)).toEqual([
      "closeAndSave",
      "note",
      "rename",
      "collapse",
      "delete",
    ]);
    const byId = Object.fromEntries(acts.map((a) => [a.id, a]));
    expect(byId.closeAndSave?.label).toBe("Close window and save (2 open tabs)");
    expect(byId.closeAndSave?.shortcut).toBe("Del");
    expect(byId.reopen?.label).toBe("Reopen all");
    expect(byId.reopen?.shortcut).toBeUndefined(); // Enter focuses a live window
    expect(byId.delete?.label).toBe("Delete (closes 2 open tabs)");
    expect(byId.delete?.danger).toBe(true);
  });

  it("live window with a closed tab inside: reopen all comes back on", () => {
    const tree = createTree([
      node("w", null, "window", { liveWindowId: 1 }),
      tab("a", "w", 10),
      tab("s", "w"),
    ]);
    const acts = containerActions(tree, tree.get("w") as ContainerNode, handlers());
    const reopen = acts.find((a) => a.id === "reopen");
    expect(reopen?.disabled).toBe(false);
    expect(reopen?.label).toBe("Reopen all (1 saved tab)");
  });

  it("saved window: reopen on, close-and-save off", () => {
    const tree = createTree([node("w", null, "window"), tab("a", "w"), tab("b", "w")]);
    const acts = containerActions(tree, tree.get("w") as ContainerNode, handlers());
    expect(enabledIds(tree, tree.get("w") as TreeNode)).toEqual([
      "reopen",
      "note",
      "rename",
      "collapse",
      "delete",
    ]);
    const byId = Object.fromEntries(acts.map((a) => [a.id, a]));
    expect(byId.reopen?.label).toBe("Reopen window (2 saved tabs)");
    expect(byId.reopen?.shortcut).toBe("Enter");
    expect(byId.closeAndSave?.label).toBe("Close all and save");
    expect(byId.delete?.label).toBe("Delete");
  });

  it("empty group: only note, rename and delete", () => {
    const tree = createTree([node("g", null, "group")]);
    expect(enabledIds(tree, tree.get("g") as TreeNode)).toEqual(["note", "rename", "delete"]);
    const acts = containerActions(tree, tree.get("g") as ContainerNode, handlers());
    expect(acts.find((a) => a.id === "reopen")?.label).toBe("Reopen all");
    expect(acts.find((a) => a.id === "collapse")?.disabled).toBe(true);
  });

  it("group with saved and live descendants (nested): everything on, counts deep", () => {
    const tree = createTree([
      node("g", null, "group", { collapsed: true }),
      tab("s", "g"),
      tab("c", "s"), // saved child of a saved tab
      tab("l", "g", 20),
      node("inner", "g", "group"),
      tab("deep", "inner", 21),
      node("noUrl", "g", "tab"), // saved tab without a url cannot be reopened
      node("memo", "g", "note", { note: "x" }),
    ]);
    expect(summarizeContainer(tree, tree.get("g") as TreeNode)).toEqual({
      savedTabs: 2,
      liveTabs: 2,
      children: 5,
      isWindow: false,
      isLiveWindow: false,
    });
    expect(enabledIds(tree, tree.get("g") as TreeNode)).toEqual(ALL);
    const acts = containerActions(tree, tree.get("g") as ContainerNode, handlers());
    const byId = Object.fromEntries(acts.map((a) => [a.id, a]));
    expect(byId.reopen?.label).toBe("Reopen all (2 saved tabs)");
    expect(byId.closeAndSave?.label).toBe("Close all and save (2 open tabs)");
    expect(byId.delete?.label).toBe("Delete (closes 2 open tabs)");
    expect(byId.collapse?.label).toBe("Expand");
  });

  it("row buttons are the enabled reopen / close / note / delete entries", () => {
    const tree = createTree([node("g", null, "group"), tab("s", "g"), tab("l", "g", 20)]);
    const acts = containerActions(tree, tree.get("g") as ContainerNode, handlers());
    expect(acts.filter((a) => a.inRow && !a.disabled).map((a) => a.id)).toEqual([
      "reopen",
      "closeAndSave",
      "note",
      "delete",
    ]);
  });

  it("runs the injected handlers with the container id", () => {
    const tree = createTree([node("g", null, "group", { collapsed: true }), tab("s", "g")]);
    const h = handlers();
    const acts = containerActions(tree, tree.get("g") as ContainerNode, h);
    for (const a of acts) a.run();
    expect(h.calls).toEqual([
      "reopenAll:g",
      "closeAndSave:g",
      "editNote:g",
      "startRename:g",
      "toggleCollapse:g:false",
      "deleteNode:g",
    ]);
  });

  it("note label reflects an existing note", () => {
    const tree = createTree([node("g", null, "group", { note: "remember" })]);
    const acts = containerActions(tree, tree.get("g") as ContainerNode, handlers());
    expect(acts.find((a) => a.id === "note")?.label).toBe("Edit note");
  });

  it("Delete key closes-and-saves while something is open, deletes otherwise", () => {
    const h = handlers();
    const withLive = createTree([node("g", null, "group"), tab("l", "g", 20)]);
    deleteKeyAction(containerActions(withLive, withLive.get("g") as ContainerNode, h))?.run();
    const allSaved = createTree([node("g", null, "group"), tab("s", "g")]);
    deleteKeyAction(containerActions(allSaved, allSaved.get("g") as ContainerNode, h))?.run();
    expect(h.calls).toEqual(["closeAndSave:g", "deleteNode:g"]);
  });
});

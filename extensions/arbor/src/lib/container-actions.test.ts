import { describe, expect, it } from "vitest";
import {
  containerActions,
  deleteKeyAction,
  isContainer,
  pinnedContainerAction,
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

/** A tab; `live` gives it a tab id in window 1 (pass `win` to put it in another window). */
const tab = (id: NodeId, parentId: NodeId, live?: number, win = 1, extra: Partial<TreeNode> = {}) =>
  node(id, parentId, "tab", {
    url: `https://${id}.test/`,
    ...(live !== undefined ? { liveTabId: live, liveWindowId: win } : {}),
    ...extra,
  });

/** A bound container: a window the browser has open. */
const openWindow = (id: NodeId, parentId: NodeId | null = null, win = 1) =>
  node(id, parentId, "window", { title: "", liveWindowId: win });
/** An unbound container with a name: what the UI calls a group. */
const group = (id: NodeId, parentId: NodeId | null = null, extra: Partial<TreeNode> = {}) =>
  node(id, parentId, "window", extra);

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
    removeNode: rec("removeNode"),
    closeAndRemove: rec("closeAndRemove"),
  };
}

const actionsOf = (tree: ReturnType<typeof createTree>, id: NodeId, h = handlers()) =>
  containerActions(tree, tree.get(id) as ContainerNode, h);
const enabledIds = (tree: ReturnType<typeof createTree>, id: NodeId) =>
  actionsOf(tree, id)
    .filter((a) => !a.disabled)
    .map((a) => a.id);
const byId = (tree: ReturnType<typeof createTree>, id: NodeId) =>
  Object.fromEntries(actionsOf(tree, id).map((a) => [a.id, a]));

const ALL = ["reopen", "closeAndSave", "note", "rename", "collapse", "remove", "closeAndRemove"];

describe("container actions", () => {
  it("every window node is a container, open or closed; tabs and notes are not", () => {
    expect(isContainer(openWindow("w"))).toBe(true);
    expect(isContainer(group("g"))).toBe(true);
    expect(isContainer(node("t", null, "tab"))).toBe(false);
    expect(isContainer(node("n", null, "note"))).toBe(false);
  });

  it("offers one action list, same order, icons, sections and row placement, bound or not", () => {
    const tree = createTree([openWindow("w"), group("g")]);
    const h = handlers();
    const bound = actionsOf(tree, "w", h);
    const unbound = actionsOf(tree, "g", h);
    expect(bound.map((a) => a.id)).toEqual(ALL);
    expect(unbound.map((a) => a.id)).toEqual(ALL);
    expect(bound.map((a) => [a.icon, a.section, a.inRow, a.danger ?? false])).toEqual(
      unbound.map((a) => [a.icon, a.section, a.inRow, a.danger ?? false]),
    );
  });

  it("bound container: close-and-save on, reopen off while nothing beneath it is closed", () => {
    const tree = createTree([openWindow("w"), tab("a", "w", 10), tab("b", "w", 11)]);
    expect(enabledIds(tree, "w")).toEqual([
      "closeAndSave",
      "note",
      "rename",
      "collapse",
      "closeAndRemove",
    ]);
    const acts = byId(tree, "w");
    expect(acts.closeAndSave?.label).toBe("Close window and save (2 open tabs)");
    expect(acts.closeAndSave?.shortcut).toBeUndefined(); // Delete no longer closes anything
    expect(acts.reopen?.label).toBe("Reopen all");
    expect(acts.reopen?.shortcut).toBeUndefined(); // Enter focuses an open window
  });

  it("bound container with a closed tab inside: reopen all comes back on", () => {
    const tree = createTree([openWindow("w"), tab("a", "w", 10), tab("s", "w")]);
    const reopen = byId(tree, "w").reopen;
    expect(reopen?.disabled).toBe(false);
    expect(reopen?.label).toBe("Reopen all (1 saved tab)");
  });

  it("unbound container (a closed window or a group): open as window on, close off", () => {
    const tree = createTree([group("w", null, { title: "" }), tab("a", "w"), tab("b", "w")]);
    expect(enabledIds(tree, "w")).toEqual(["reopen", "note", "rename", "collapse", "remove"]);
    const acts = byId(tree, "w");
    expect(acts.reopen?.label).toBe("Open as window (2 saved tabs)");
    expect(acts.reopen?.shortcut).toBe("Enter");
    expect(acts.closeAndSave?.label).toBe("Close all and save");
    expect(acts.remove?.label).toBe("Remove from tree");
    // The very same labels for a group: the title does not change what the row can do.
    const named = createTree([group("g"), tab("a", "g"), tab("b", "g")]);
    expect(actionsOf(named, "g").map((a) => [a.label, a.disabled])).toEqual(
      actionsOf(tree, "w").map((a) => [a.label, a.disabled]),
    );
  });

  it("empty group: only note, rename and remove", () => {
    const tree = createTree([group("g")]);
    expect(enabledIds(tree, "g")).toEqual(["note", "rename", "remove"]);
    const acts = byId(tree, "g");
    expect(acts.reopen?.label).toBe("Open as window");
    expect(acts.collapse?.disabled).toBe(true);
  });

  it("group with saved and live descendants: counts follow what each action does", () => {
    const tree = createTree([
      group("g", null, { collapsed: true }),
      tab("s", "g"),
      tab("c", "s"), // saved child of a saved tab
      tab("l", "g", 20), // open in window 1 while the group has no window: "elsewhere"
      group("inner", "g"), // a nested container is a window of its own
      tab("deep", "inner", 21),
      tab("innerSaved", "inner"),
      node("noUrl", "g", "tab"), // saved tab without a url cannot be reopened
      node("memo", "g", "note", { note: "x" }),
    ]);
    expect(summarizeContainer(tree, tree.get("g") as TreeNode)).toEqual({
      savedTabs: 2, // s, c; innerSaved belongs to the nested container's own Reopen
      liveTabs: 2, // l and deep: closing the group closes the nested window too
      liveElsewhere: 1, // l
      children: 5, // s, l, inner, noUrl, memo
      bound: false,
    });
    expect(enabledIds(tree, "g")).toEqual(ALL);
    const acts = byId(tree, "g");
    expect(acts.reopen?.label).toBe("Open as window (2 saved tabs, 1 open tab)");
    expect(acts.closeAndSave?.label).toBe("Close all and save (2 open tabs)");
    expect(acts.remove?.label).toBe("Remove from tree (keeps 2 open tabs)");
    expect(acts.closeAndRemove?.label).toBe("Close tabs and remove (2 open tabs)");
    expect(acts.collapse?.label).toBe("Expand");
  });

  it("an unbound container holding only open tabs (dragged in) can still be opened as a window", () => {
    const tree = createTree([group("g"), tab("l", "g", 20)]);
    const acts = byId(tree, "g");
    expect(acts.reopen?.disabled).toBe(false);
    expect(acts.reopen?.label).toBe("Open as window (1 open tab)");
    // Not pinned: something is open beneath it, so the row shows its buttons on hover as usual.
    expect(pinnedContainerAction(actionsOf(tree, "g"))).toBeUndefined();
  });

  it("bound container: tabs open in another window do not make Reopen all available", () => {
    const tree = createTree([openWindow("w"), tab("a", "w", 10), tab("x", "w", 30, 2)]);
    expect(summarizeContainer(tree, tree.get("w") as TreeNode).liveElsewhere).toBe(1);
    expect(byId(tree, "w").reopen?.disabled).toBe(true);
  });

  it("row buttons are the enabled reopen / close / note / remove entries; close-and-remove is menu only", () => {
    const tree = createTree([group("g"), tab("s", "g"), tab("l", "g", 20)]);
    const acts = actionsOf(tree, "g");
    expect(acts.filter((a) => a.inRow && !a.disabled).map((a) => a.id)).toEqual([
      "reopen",
      "closeAndSave",
      "note",
      "remove",
    ]);
    expect(acts.find((a) => a.id === "closeAndRemove")).toMatchObject({
      inRow: false,
      danger: true,
      disabled: false,
      shortcut: "Shift+Del",
    });
    const remove = acts.find((a) => a.id === "remove");
    expect(remove?.shortcut).toBe("Del");
    expect(remove?.danger).toBeFalsy(); // it never closes anything
  });

  it("runs the injected handlers with the container id", () => {
    const tree = createTree([
      group("g", null, { collapsed: true }),
      tab("s", "g"),
      tab("l", "g", 20),
    ]);
    const h = handlers();
    for (const a of actionsOf(tree, "g", h)) a.run();
    expect(h.calls).toEqual([
      "reopenAll:g",
      "closeAndSave:g",
      "editNote:g",
      "startRename:g",
      "toggleCollapse:g:false",
      "removeNode:g",
      "closeAndRemove:g",
    ]);
  });

  it("note label reflects an existing note", () => {
    const tree = createTree([group("g", null, { note: "remember" })]);
    expect(byId(tree, "g").note?.label).toBe("Edit note");
  });

  it("a group whose tabs were closed offers Open as window as its first row button and menu entry", () => {
    // The owner's scenario: make a group, drag tabs in, close them; the group must offer a way
    // to bring them all back. Row buttons and the context menu render from this same list.
    const tree = createTree([group("g"), tab("a", "g"), tab("b", "g"), tab("c", "g")]);
    const h = handlers();
    const acts = actionsOf(tree, "g", h);
    const rowButtons = acts.filter((a) => a.inRow && !a.disabled);
    expect(rowButtons[0]?.id).toBe("reopen");
    expect(rowButtons[0]?.label).toBe("Open as window (3 saved tabs)");
    expect(rowButtons[0]?.icon).toBe("restore");
    expect(acts.filter((a) => a.section === "open").map((a) => [a.id, a.disabled])).toEqual([
      ["reopen", false],
      ["closeAndSave", true],
    ]);
    expect(acts.find((a) => a.id === "reopen")?.shortcut).toBe("Enter");
    rowButtons[0]?.run();
    expect(h.calls).toEqual(["reopenAll:g"]);
  });

  it("pins Reopen on a fully closed container so it shows without hovering", () => {
    const closedGroup = createTree([group("g"), tab("a", "g")]);
    expect(pinnedContainerAction(actionsOf(closedGroup, "g"))?.id).toBe("reopen");
    const closedWindow = createTree([group("w", null, { title: "" }), tab("a", "w")]);
    expect(pinnedContainerAction(actionsOf(closedWindow, "w"))?.label).toBe(
      "Open as window (1 saved tab)",
    );
    // Nothing pinned while something beneath is still open, or when there is nothing to reopen.
    const mixed = createTree([group("g"), tab("a", "g"), tab("l", "g", 20)]);
    expect(pinnedContainerAction(actionsOf(mixed, "g"))).toBeUndefined();
    const empty = createTree([group("g")]);
    expect(pinnedContainerAction(actionsOf(empty, "g"))).toBeUndefined();
  });

  describe("remove from tree vs close tabs and remove", () => {
    it("a group: remove is on whatever it holds and keeps open tabs; close-and-remove needs open tabs", () => {
      const withLive = createTree([group("g"), tab("l", "g", 20), tab("s", "g")]);
      expect(byId(withLive, "g").remove).toMatchObject({
        label: "Remove from tree (keeps 1 open tab)",
        disabled: false,
      });
      expect(byId(withLive, "g").closeAndRemove).toMatchObject({
        label: "Close tabs and remove (1 open tab)",
        disabled: false,
      });
      const allSaved = createTree([group("g"), tab("s", "g")]);
      expect(byId(allSaved, "g").remove).toMatchObject({
        label: "Remove from tree",
        disabled: false,
      });
      expect(byId(allSaved, "g").closeAndRemove).toMatchObject({
        label: "Close tabs and remove",
        disabled: true,
      });
      const empty = createTree([group("g")]);
      expect(byId(empty, "g").remove?.disabled).toBe(false);
      expect(byId(empty, "g").closeAndRemove?.disabled).toBe(true);
    });

    it("an open window stays in the tree: remove reads 'Remove saved items' and is off with nothing to remove", () => {
      // Only open tabs, each directly under its window, no title, no note: nothing to remove.
      const plain = createTree([openWindow("w"), tab("a", "w", 10), tab("b", "w", 11)]);
      expect(byId(plain, "w").remove).toMatchObject({
        label: "Remove saved items",
        disabled: true,
      });
      expect(byId(plain, "w").closeAndRemove).toMatchObject({
        label: "Close tabs and remove (2 open tabs)",
        disabled: false,
      });
      // Open tabs nested under an open tab (opened from it) stay nested: still nothing to remove.
      const nested = createTree([openWindow("w"), tab("a", "w", 10), tab("b", "a", 11)]);
      expect(byId(nested, "w").remove?.disabled).toBe(true);
      // A saved tab, a note, a title or a tab from another window filed here: something to remove.
      const withSaved = createTree([openWindow("w"), tab("a", "w", 10), tab("s", "w")]);
      expect(byId(withSaved, "w").remove?.disabled).toBe(false);
      const titled = createTree([node("w", null, "window", { title: "Work", liveWindowId: 1 })]);
      expect(byId(titled, "w").remove?.disabled).toBe(false);
      const noted = createTree([openWindow("w"), tab("a", "w", 10, 1, { note: "todo" })]);
      expect(byId(noted, "w").remove?.disabled).toBe(false);
      const elsewhere = createTree([
        openWindow("w"),
        openWindow("w2", null, 2),
        tab("a", "w", 10),
        tab("x", "w", 30, 2), // open in window 2, filed under window 1: goes back to window 2
      ]);
      expect(byId(elsewhere, "w").remove?.disabled).toBe(false);
      // An open tab under a saved tab: the saved tab goes, the open one moves up.
      const underSaved = createTree([openWindow("w"), tab("s", "w"), tab("a", "s", 10)]);
      expect(byId(underSaved, "w").remove?.disabled).toBe(false);
      // An open window without tabs beneath it in the tree has nothing to close.
      const bare = createTree([openWindow("w")]);
      expect(byId(bare, "w").closeAndRemove?.disabled).toBe(true);
    });

    it("Delete key runs remove, Shift+Delete runs close-and-remove, neither when disabled", () => {
      const h = handlers();
      const withLive = createTree([group("g"), tab("l", "g", 20)]);
      deleteKeyAction(actionsOf(withLive, "g", h), { shift: false })?.run();
      deleteKeyAction(actionsOf(withLive, "g", h), { shift: true })?.run();
      expect(h.calls).toEqual(["removeNode:g", "closeAndRemove:g"]);
      // Nothing open beneath: Shift+Delete does nothing rather than falling back to remove.
      const allSaved = createTree([group("g"), tab("s", "g")]);
      expect(deleteKeyAction(actionsOf(allSaved, "g", h), { shift: true })).toBeUndefined();
      // Nothing to remove on a plain open window: Delete does nothing (and never closes a tab).
      const plain = createTree([openWindow("w"), tab("a", "w", 10)]);
      expect(deleteKeyAction(actionsOf(plain, "w", h), { shift: false })).toBeUndefined();
      expect(h.calls).toEqual(["removeNode:g", "closeAndRemove:g"]);
    });
  });
});

import { describe, expect, it } from "vitest";
import { makeNode, type TreeNode } from "./model";
import { isLiveNode, primaryActionFor } from "./primary-action";

const node = (kind: TreeNode["kind"], extra: Partial<TreeNode> = {}): TreeNode => ({
  ...makeNode({ id: "n", parentId: null, kind, title: kind, ts: 1 }),
  ...extra,
});

/**
 * Enter and double-click go through `primaryActionFor`; the row's Restore button and the context
 * menu's Restore entry call `restore` directly. Both roads end at the `restoreNode` message, so a
 * saved tab inside a group is reopened in place whichever way the user triggers it.
 */
describe("primary action (Enter / double-click)", () => {
  it("focuses a live tab and a bound container (open window)", () => {
    expect(primaryActionFor(node("tab", { liveTabId: 5, liveWindowId: 1 }))).toBe("focus");
    expect(primaryActionFor(node("window", { liveWindowId: 1, title: "" }))).toBe("focus");
    expect(primaryActionFor(node("window", { liveWindowId: 1, title: "Named" }))).toBe("focus");
  });

  it("restores (reopens in place) a saved tab, an unbound container (closed window or group) and a note", () => {
    expect(primaryActionFor(node("tab", { url: "https://a.test/" }))).toBe("restore");
    expect(primaryActionFor(node("window", { title: "" }))).toBe("restore");
    expect(primaryActionFor(node("window", { title: "Research" }))).toBe("restore");
    expect(primaryActionFor(node("note"))).toBe("restore");
  });

  it("a tab whose window is gone but that still carries a tab id counts as live", () => {
    // The tracker clears both ids together; a lone liveTabId means the tab is open.
    expect(isLiveNode(node("tab", { liveTabId: 9 }))).toBe(true);
    expect(isLiveNode(node("tab", { liveWindowId: 9 }))).toBe(false);
  });
});

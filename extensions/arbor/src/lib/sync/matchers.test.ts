import { describe, expect, it } from "vitest";
import { applyOps, createTree, makeNode, ops, type Tree, type TreeNode } from "../model";
import { RebuildMatcher } from "./matchers";
import type { LiveTab } from "./types";

function win(id: string, liveWindowId?: number, title = ""): TreeNode {
  return makeNode({ id, parentId: null, kind: "window", title, liveWindowId, ts: 1 });
}

function tab(id: string, parentId: string, url: string, live?: { tab: number; win: number }) {
  return makeNode({
    id,
    parentId,
    kind: "tab",
    title: id,
    url,
    liveTabId: live?.tab,
    liveWindowId: live?.win,
    ts: 1,
  });
}

const liveTab = (id: number, windowId: number, url: string): LiveTab => ({
  id,
  windowId,
  index: 0,
  url,
});

/** Window 1 (bound) with A live, B saved; group G with saved S; stray D lives in window 1. */
function fixture(): Tree {
  return applyOps(
    createTree(),
    [
      ops.add(win("w", 1)),
      ops.add(tab("a", "w", "https://a.test/", { tab: 10, win: 1 })),
      ops.add(tab("b", "w", "https://b.test/")),
      ops.add(win("g", undefined, "Reading")),
      ops.add(tab("s", "g", "https://s.test/")),
      ops.add(tab("d", "g", "https://d.test/", { tab: 11, win: 1 })),
    ],
    1,
  );
}

describe("RebuildMatcher.tabNodesOf", () => {
  it("includes stray tab nodes that still carry the container's live window id", () => {
    const matcher = new RebuildMatcher(fixture());
    const ids = matcher.tabNodesOf(fixture().get("w") as TreeNode).map((n) => n.id);
    expect(ids).toEqual(["a", "b", "d"]);
    expect(matcher.tabNodesOf(fixture().get("g") as TreeNode).map((n) => n.id)).toEqual(["s", "d"]);
  });
});

describe("RebuildMatcher.matchWindow", () => {
  it("trusts the live id when one tab still matches by id and url", () => {
    const matcher = new RebuildMatcher(fixture());
    const match = matcher.matchWindow(1, [liveTab(10, 1, "https://a.test/")], new Set());
    expect(match).toMatchObject({ node: { id: "w" }, idsValid: true });
  });

  it("falls back to url overlap when ids changed (browser restart)", () => {
    const matcher = new RebuildMatcher(fixture());
    const tabs = [liveTab(70, 5, "https://a.test/"), liveTab(71, 5, "https://b.test/")];
    const match = matcher.matchWindow(5, tabs, new Set());
    expect(match).toMatchObject({ node: { id: "w" }, idsValid: false });
  });

  it("needs at least half of the meaningful tabs to overlap", () => {
    const matcher = new RebuildMatcher(fixture());
    const tabs = [
      liveTab(70, 5, "https://a.test/"),
      liveTab(71, 5, "https://x.test/"),
      liveTab(72, 5, "https://y.test/"),
    ];
    expect(matcher.matchWindow(5, tabs, new Set())).toBeUndefined();
  });

  it("does not hand a user's group to a window that merely shows the same page", () => {
    const tree = applyOps(
      fixture(),
      [ops.add(tab("s2", "w", "https://s.test/")), ops.remove("d")],
      1,
    );
    const matcher = new RebuildMatcher(tree);
    // Both W (was bound, untitled) and G (a titled group) hold s.test; W wins the tie.
    const match = matcher.matchWindow(9, [liveTab(70, 9, "https://s.test/")], new Set());
    expect(match?.node.id).toBe("w");
  });

  it("skips containers already claimed by another window", () => {
    const matcher = new RebuildMatcher(fixture());
    const match = matcher.matchWindow(1, [liveTab(10, 1, "https://a.test/")], new Set(["w"]));
    expect(match).toBeUndefined();
  });
});

describe("RebuildMatcher.matchTab", () => {
  const candidates = () => new RebuildMatcher(fixture()).tabNodesOf(fixture().get("w") as TreeNode);

  it("prefers the node with the same live id when ids are trusted", () => {
    const matcher = new RebuildMatcher(fixture());
    const hit = matcher.matchTab(liveTab(10, 1, "https://elsewhere.test/"), candidates(), {
      idsValid: true,
      used: new Set(),
    });
    expect(hit?.id).toBe("a");
  });

  it("prefers a saved node over a live one with the same url when ids are not trusted", () => {
    const matcher = new RebuildMatcher(fixture());
    const nodes = [...candidates(), tab("a2", "w", "https://a.test/")];
    const hit = matcher.matchTab(liveTab(99, 1, "https://a.test/"), nodes, {
      idsValid: false,
      used: new Set(),
    });
    expect(hit?.id).toBe("a2");
  });

  it("never returns a node another tab already took", () => {
    const matcher = new RebuildMatcher(fixture());
    const hit = matcher.matchTab(liveTab(10, 1, "https://a.test/"), candidates(), {
      idsValid: true,
      used: new Set(["a"]),
    });
    expect(hit).toBeUndefined();
  });
});

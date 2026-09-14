import { describe, expect, it } from "vitest";
import { LiveBooks } from "./live-books";
import type { LiveTab } from "./types";

const tab = (id: number, windowId: number, index: number, active = false): LiveTab => ({
  id,
  windowId,
  index,
  active,
});

describe("LiveBooks", () => {
  it("keeps the strip in browser order through inserts, moves and removals", () => {
    const books = new LiveBooks();
    books.insertTabRecord(tab(1, 7, 0));
    books.insertTabRecord(tab(3, 7, 1));
    books.insertTabRecord(tab(2, 7, 1)); // opened between 1 and 3
    expect(books.stripOf(7)).toEqual([1, 2, 3]);
    expect(books.moveInStrip(3, 7, 0)).toBe(true);
    expect(books.stripOf(7)).toEqual([3, 1, 2]);
    expect(books.moveInStrip(99, 7, 0)).toBe(false);
    books.removeTabRecord(1);
    expect(books.stripOf(7)).toEqual([3, 2]);
    expect(books.hasTab(1)).toBe(false);
  });

  it("tracks the active tab per window and the focused window", () => {
    const books = new LiveBooks();
    books.insertTabRecord(tab(1, 7, 0, true));
    books.insertTabRecord(tab(2, 7, 1));
    expect(books.activeOrFirstTab(7)).toBe(1);
    books.setActive(7, 2);
    expect(books.getLiveState().activeTabIds).toEqual([2]);
    books.focusedWindowId = 7;
    books.forgetWindow(7);
    expect(books.getLiveState()).toEqual({ activeTabIds: [], focusedWindowId: undefined });
    expect(books.stripOf(7)).toBeUndefined();
  });

  it("swaps a replaced tab id in place and reports unknown ids", () => {
    const books = new LiveBooks();
    books.insertTabRecord(tab(1, 7, 0, true));
    expect(books.replaceTabId(1, 5)).toBe(true);
    expect(books.stripOf(7)).toEqual([5]);
    expect(books.activeOrFirstTab(7)).toBe(5);
    expect(books.replaceTabId(1, 6)).toBe(false);
  });

  it("only ignores windows it was told are not trackable", () => {
    const books = new LiveBooks();
    books.noteWindow(1, true);
    books.noteWindow(2, false);
    expect(books.ignoresWindow(1)).toBe(false);
    expect(books.ignoresWindow(2)).toBe(true);
    expect(books.ignoresWindow(3)).toBe(false); // unknown windows are trusted
    expect(books.seesWindowOpen(1)).toBe(true);
    expect(books.seesWindowOpen(3)).toBe(false);
    books.insertTabRecord(tab(9, 3, 0));
    expect(books.seesWindowOpen(3)).toBe(true);
  });

  it("counts the tabs a window still holds, minus the ones about to close", () => {
    const books = new LiveBooks();
    books.insertTabRecord(tab(1, 7, 0));
    books.insertTabRecord(tab(2, 7, 1));
    expect(books.realTabsRemaining(7)).toBe(2);
    expect(books.realTabsRemaining(7, new Set([1]))).toBe(1);
    expect(books.realTabsRemaining(8)).toBe(0);
  });
});

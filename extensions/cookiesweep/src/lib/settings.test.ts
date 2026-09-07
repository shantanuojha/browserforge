import { describe, expect, it } from "vitest";
import {
  ACTIVITY_LOG_CAP,
  DEFAULT_SETTINGS,
  addListEntry,
  appendActivity,
  clampDelay,
  dedupeListEntries,
  isValidPattern,
  normalizeListEntry,
  normalizePattern,
  normalizeSettings,
  removeListEntry,
  type ActivityEntry,
} from "./settings.js";

describe("normalizeSettings", () => {
  it("returns defaults for garbage", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("nope")).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings([])).toEqual(DEFAULT_SETTINGS);
  });
  it("fills missing fields and coerces types", () => {
    const s = normalizeSettings({
      enabled: false,
      delaySeconds: "42",
      lists: [
        { pattern: " *.Example.com ", listType: "GREY" },
        { pattern: "bad pattern", listType: "white" },
        { pattern: "ok.com", listType: "white", storeId: "  " },
        { pattern: "store.com", listType: "unknown", storeId: "firefox-container-2" },
        42,
      ],
    });
    expect(s.enabled).toBe(false);
    expect(s.delaySeconds).toBe(42);
    expect(s.cleanSiteData).toBe(true);
    expect(s.cleanOnStartup).toBe(false);
    expect(s.notifications).toBe(false);
    expect(s.lists).toEqual([
      { pattern: "*.example.com", listType: "grey" },
      { pattern: "ok.com", listType: "white" },
      { pattern: "store.com", listType: "white", storeId: "firefox-container-2" },
    ]);
  });
  it("clamps the delay", () => {
    expect(clampDelay(-5)).toBe(0);
    expect(clampDelay(99999)).toBe(3600);
    expect(clampDelay(14.6)).toBe(15);
    expect(clampDelay("abc")).toBe(15);
    expect(clampDelay(NaN)).toBe(15);
  });
});

describe("patterns", () => {
  it("normalises wildcards, case and dots", () => {
    expect(normalizePattern("*.Example.com.")).toBe("*.example.com");
    expect(normalizePattern("*Example.com")).toBe("*example.com");
    expect(normalizePattern(" https://Example.com/x ")).toBe("example.com");
    expect(normalizePattern(".example.com")).toBe("example.com");
  });
  it("validates patterns", () => {
    expect(isValidPattern("example.com")).toBe(true);
    expect(isValidPattern("*.example.com")).toBe(true);
    expect(isValidPattern("*example.com")).toBe(true);
    expect(isValidPattern("localhost")).toBe(true);
    expect(isValidPattern("127.0.0.1")).toBe(true);
    expect(isValidPattern("")).toBe(false);
    expect(isValidPattern("*")).toBe(false);
    expect(isValidPattern("*.")).toBe(false);
    expect(isValidPattern("exa mple.com")).toBe(false);
    expect(isValidPattern("example.com/path")).toBe(false);
    expect(isValidPattern("ex*ample.com")).toBe(false);
  });
  it("normalizeListEntry rejects invalid input", () => {
    expect(normalizeListEntry(null)).toBeNull();
    expect(normalizeListEntry({})).toBeNull();
    expect(normalizeListEntry({ pattern: "" })).toBeNull();
    expect(normalizeListEntry({ pattern: "a.com", listType: "gray" })).toEqual({
      pattern: "a.com",
      listType: "grey",
    });
  });
});

describe("list editing", () => {
  it("dedupes by pattern and store, last wins", () => {
    const lists = dedupeListEntries([
      { pattern: "a.com", listType: "white" },
      { pattern: "a.com", listType: "grey" },
      { pattern: "a.com", listType: "white", storeId: "1" },
    ]);
    expect(lists).toEqual([
      { pattern: "a.com", listType: "grey" },
      { pattern: "a.com", listType: "white", storeId: "1" },
    ]);
  });
  it("adds and removes entries", () => {
    let lists = addListEntry([], { pattern: "A.com", listType: "white" });
    lists = addListEntry(lists, { pattern: "*b.com", listType: "grey" });
    lists = addListEntry(lists, { pattern: "bad pattern", listType: "grey" });
    expect(lists).toEqual([
      { pattern: "a.com", listType: "white" },
      { pattern: "*b.com", listType: "grey" },
    ]);
    lists = removeListEntry(lists, { pattern: "a.com" });
    expect(lists).toEqual([{ pattern: "*b.com", listType: "grey" }]);
    lists = removeListEntry(lists, { pattern: "*b.com", storeId: "1" });
    expect(lists).toHaveLength(1);
  });
});

describe("appendActivity", () => {
  const entry = (i: number): ActivityEntry => ({
    id: String(i),
    at: i,
    trigger: "tab-close",
    storeId: "0",
    domains: ["a.com"],
    cookiesRemoved: 1,
    siteDataDomains: 0,
  });
  it("prepends and caps", () => {
    let log: ActivityEntry[] = [];
    for (let i = 0; i < ACTIVITY_LOG_CAP + 10; i++) log = appendActivity(log, entry(i));
    expect(log).toHaveLength(ACTIVITY_LOG_CAP);
    expect(log[0]?.id).toBe(String(ACTIVITY_LOG_CAP + 9));
    expect(log.at(-1)?.id).toBe("10");
  });
  it("honours a custom cap", () => {
    expect(appendActivity([entry(1), entry(2)], entry(3), 2).map((e) => e.id)).toEqual(["3", "1"]);
  });
});

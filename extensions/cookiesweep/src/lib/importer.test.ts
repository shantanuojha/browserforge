import { describe, expect, it } from "vitest";
import {
  buildExport,
  convertCadExpression,
  mergeLists,
  parseImport,
  serializeExport,
} from "./importer.js";

describe("convertCadExpression", () => {
  it("maps CAD wildcards to our apex-inclusive wildcard", () => {
    expect(convertCadExpression("*.example.com")).toBe("*example.com");
    expect(convertCadExpression("*.Example.COM ")).toBe("*example.com");
    expect(convertCadExpression("example.com")).toBe("example.com");
    expect(convertCadExpression("*example.com")).toBe("*example.com");
    expect(convertCadExpression(".example.com")).toBe("example.com");
  });
});

describe("parseImport: Cookie AutoDelete 3.x", () => {
  const cad = JSON.stringify([
    { expression: "*.github.com", listType: "WHITE", storeId: "default" },
    { expression: "news.ycombinator.com", listType: "GREY", storeId: "default" },
    {
      expression: "*.mozilla.org",
      listType: "WHITE",
      storeId: "firefox-container-1",
      cookieNames: ["sessionid"],
      id: "abc",
    },
    { expression: "", listType: "WHITE", storeId: "default" },
    { listType: "WHITE", storeId: "default" },
    { expression: "bad domain", listType: "WHITE" },
    "loose-string.example",
    42,
  ]);

  it("imports valid entries and reports the rest", () => {
    const result = parseImport(cad);
    expect(result.format).toBe("cookie-autodelete");
    expect(result.entries).toEqual([
      { pattern: "*github.com", listType: "white" },
      { pattern: "news.ycombinator.com", listType: "grey" },
      { pattern: "*mozilla.org", listType: "white", storeId: "firefox-container-1" },
      { pattern: "loose-string.example", listType: "white" },
    ]);
    expect(result.skipped.map((s) => [s.index, s.reason])).toEqual([
      [3, "Missing expression/domain"],
      [4, "Missing expression/domain"],
      [5, 'Invalid pattern "bad domain"'],
      [7, "Not an object"],
    ]);
    expect(result.warnings.some((w) => w.includes("cookieNames"))).toBe(true);
  });

  it("accepts the older `domain` key and lowercase list types", () => {
    const result = parseImport([
      { domain: "Example.com", listType: "white", storeId: "default" },
      { domain: "*.grey.com", listType: "gray" },
      { domain: "typo.com", listType: "BLUE" },
    ]);
    expect(result.entries).toEqual([
      { pattern: "example.com", listType: "white" },
      { pattern: "*grey.com", listType: "grey" },
      { pattern: "typo.com", listType: "white" },
    ]);
    expect(result.warnings.some((w) => w.includes("unknown list type"))).toBe(true);
  });

  it("flattens store-keyed backups", () => {
    const result = parseImport({
      lists: {
        default: [{ expression: "a.com", listType: "WHITE" }],
        "firefox-container-2": [{ expression: "b.com", listType: "GREY" }],
        junk: "not a list",
      },
    });
    expect(result.entries).toEqual([
      { pattern: "a.com", listType: "white" },
      { pattern: "b.com", listType: "grey", storeId: "firefox-container-2" },
    ]);
  });

  it("reads the real CAD 'Export expressions' file (root keyed by store id)", () => {
    // CAD's Expressions.tsx does `downloadObjectAsJSON(this.props.lists)`; `lists` is
    // StoreIdToExpressionList, i.e. the root object is keyed by store id.
    const result = parseImport({
      default: [
        { expression: "*.github.com", listType: "WHITE", storeId: "default", id: "x1" },
        // Added by CAD's "Create default options" button; not a domain.
        { expression: "_Default:WHITE", listType: "WHITE", storeId: "firefox-default" },
        { expression: "_Default:GREY", listType: "GREY", storeId: "0" },
      ],
      "firefox-container-1": [
        { expression: "work.example", listType: "GREY", storeId: "firefox-container-1" },
      ],
    });
    expect(result.format).toBe("cookie-autodelete");
    expect(result.entries).toEqual([
      { pattern: "*github.com", listType: "white" },
      { pattern: "work.example", listType: "grey", storeId: "firefox-container-1" },
    ]);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      "Cookie AutoDelete internal default entry",
      "Cookie AutoDelete internal default entry",
    ]);
  });

  it("maps CAD's Chrome incognito alias 'private' to Chrome's store id", () => {
    // CAD's getStoreId() rewrites Chrome store "1" to "private" before saving.
    const result = parseImport([
      { expression: "a.com", listType: "WHITE", storeId: "private" },
      { expression: "b.com", listType: "WHITE", storeId: "firefox-private" },
    ]);
    expect(result.entries).toEqual([
      { pattern: "a.com", listType: "white", storeId: "1" },
      { pattern: "b.com", listType: "white", storeId: "firefox-private" },
    ]);
  });

  it("imports internationalised expressions in the form cookies use", () => {
    const result = parseImport([{ expression: "*.münchen.de", listType: "WHITE" }]);
    expect(result.entries).toEqual([{ pattern: "*xn--mnchen-3ya.de", listType: "white" }]);
  });

  it("merges duplicates and warns", () => {
    const result = parseImport([
      { expression: "a.com", listType: "WHITE" },
      { expression: "a.com", listType: "GREY" },
    ]);
    expect(result.entries).toEqual([{ pattern: "a.com", listType: "grey" }]);
    expect(result.warnings.some((w) => w.includes("duplicate"))).toBe(true);
  });

  it("rejects invalid JSON and unknown shapes", () => {
    expect(parseImport("{nope").skipped[0]?.reason).toBe("Not valid JSON");
    expect(parseImport("42").format).toBe("unknown");
    expect(parseImport({ foo: "bar" }).entries).toEqual([]);
    expect(parseImport(null).entries).toEqual([]);
  });
});

describe("CookieSweep export round-trip", () => {
  it("exports and re-imports losslessly", () => {
    const lists = [
      { pattern: "*example.com", listType: "white" as const },
      { pattern: "*.sub.example.com", listType: "grey" as const, storeId: "1" },
    ];
    const json = serializeExport(lists, new Date("2026-01-02T03:04:05Z"));
    const parsed = JSON.parse(json);
    expect(parsed.app).toBe("cookiesweep");
    expect(parsed.version).toBe(1);
    expect(parsed.exportedAt).toBe("2026-01-02T03:04:05.000Z");
    const result = parseImport(json);
    expect(result.format).toBe("cookiesweep");
    // Our own format keeps `*.` (subdomains-only) semantics intact.
    expect(result.entries).toEqual(lists);
  });
  it("buildExport dedupes", () => {
    const out = buildExport([
      { pattern: "a.com", listType: "white" },
      { pattern: "a.com", listType: "grey" },
    ]);
    expect(out.lists).toEqual([{ pattern: "a.com", listType: "grey" }]);
  });
});

describe("mergeLists", () => {
  it("lets imported entries override existing ones", () => {
    expect(
      mergeLists(
        [
          { pattern: "a.com", listType: "white" },
          { pattern: "b.com", listType: "white" },
        ],
        [{ pattern: "a.com", listType: "grey" }],
      ),
    ).toEqual([
      { pattern: "a.com", listType: "grey" },
      { pattern: "b.com", listType: "white" },
    ]);
  });
});

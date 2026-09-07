import { describe, expect, it } from "vitest";
import { RULE_PACKS, fillPlaceholders, instantiatePack, missingVariables } from "../packs";
import { compileToDNR, matchRule } from "./engine";
import { createRule } from "./model";
import {
  convertRedirectorRedirect,
  importRedirector,
  importRedirectorJson,
  looksLikeRedirectorExport,
} from "./redirector-import";
import { decodeShareLink, encodeShareLink, isShareLink } from "./share";

// Shaped like a real Redirector v3.5.3 export.
const REDIRECTOR_EXPORT = {
  createdBy: "Redirector v3.5.3",
  createdAt: "2024-01-01T00:00:00.000Z",
  redirects: [
    {
      description: "Example redirects to example",
      exampleUrl: "http://example.com/some-page.html",
      exampleResult: "https://example.com/some-page.html",
      error: null,
      includePattern: "http://example.com/*",
      excludePattern: "",
      patternDesc: "Any url starting with http://example.com/ will be redirected to https",
      redirectUrl: "https://example.com/$1",
      patternType: "W",
      processMatches: "noProcessing",
      disabled: false,
      grouped: false,
      appliesTo: ["main_frame"],
    },
    {
      description: "De-google redirect links",
      exampleUrl: "https://www.google.com/url?q=https%3A%2F%2Fexample.com%2F&sa=D",
      exampleResult: "https://example.com/",
      error: null,
      includePattern: "^https://www\\.google\\.com/url\\?.*?q=([^&]+)",
      excludePattern: "",
      patternDesc: "",
      redirectUrl: "$1",
      patternType: "R",
      processMatches: "urlDecode",
      disabled: false,
      grouped: false,
      appliesTo: ["main_frame", "history"],
    },
    {
      description: "Images from mirror",
      includePattern: "https://img.example/*",
      excludePattern: "https://img.example/keep/*",
      redirectUrl: "https://mirror.example/$1",
      patternType: "W",
      processMatches: "base64decode",
      disabled: true,
      appliesTo: ["image", "imageset", "sub_frame", "bogus"],
    },
  ],
};

describe("Redirector importer", () => {
  it("imports a full export faithfully", () => {
    const res = importRedirector(REDIRECTOR_EXPORT);
    expect(res.errors).toEqual([]);
    expect(res.source).toBe("Redirector v3.5.3");
    expect(res.items).toHaveLength(3);

    const [a, b, c] = res.items;
    expect(a!.rule).toMatchObject({
      name: "Example redirects to example",
      enabled: true,
      matchType: "wildcard",
      include: "http://example.com/*",
      exclude: [],
      redirectTo: "https://example.com/$1",
      transforms: [],
      applyTo: "navigation",
      resourceTypes: [],
    });
    expect(a!.warnings).toEqual([]);

    expect(b!.rule).toMatchObject({
      matchType: "regex",
      transforms: ["decodeURIComponent"],
      applyTo: "navigation",
    });

    expect(c!.rule).toMatchObject({
      enabled: false,
      exclude: ["https://img.example/keep/*"],
      transforms: ["atob"],
      applyTo: "all",
      resourceTypes: ["image", "sub_frame"],
    });
    expect(c!.warnings.some((w) => w.includes("bogus"))).toBe(true);
  });

  it("imported rules behave like Redirector's exampleUrl/exampleResult", () => {
    const res = importRedirector(REDIRECTOR_EXPORT);
    const cases: [string, string][] = [
      ["http://example.com/some-page.html", "https://example.com/some-page.html"],
      ["https://www.google.com/url?q=https%3A%2F%2Fexample.com%2F&sa=D", "https://example.com/"],
    ];
    cases.forEach(([url, expected], i) => {
      expect(matchRule(url, res.items[i]!.rule)).toBe(expected);
    });
  });

  it("accepts bare arrays and reports bad entries", () => {
    const res = importRedirector([
      { includePattern: "a*", redirectUrl: "https://b/$1" },
      { redirectUrl: "x" },
      { includePattern: "(", redirectUrl: "x", patternType: "R" },
      { includePattern: "a", redirectUrl: "x", patternType: "Q" },
      5,
    ]);
    expect(res.items).toHaveLength(1);
    expect(res.errors).toHaveLength(4);
    expect(importRedirector({ nope: true }).errors).toHaveLength(1);
    expect(importRedirectorJson("{bad").errors[0]).toMatch(/Invalid JSON/);
  });

  it("maps processMatches and warns on unknown values", () => {
    const base = { includePattern: "a", redirectUrl: "https://b/" };
    const t = (pm: string) => {
      const r = convertRedirectorRedirect({ ...base, processMatches: pm }, 0);
      return typeof r === "string" ? r : r.rule.transforms;
    };
    expect(t("noProcessing")).toEqual([]);
    expect(t("urlDecode")).toEqual(["decodeURIComponent"]);
    expect(t("urlEncode")).toEqual(["encodeURIComponent"]);
    expect(t("base64decode")).toEqual(["atob"]);
    expect(t("base64encode")).toEqual(["btoa"]);
    const unknown = convertRedirectorRedirect({ ...base, processMatches: "rot13" }, 0);
    expect(typeof unknown === "string" ? [] : unknown.warnings).toHaveLength(1);
  });

  it("drops invalid regex excludes with a warning", () => {
    const r = convertRedirectorRedirect(
      { includePattern: "^a$", excludePattern: "(", redirectUrl: "https://b/", patternType: "R" },
      0,
    );
    expect(typeof r).not.toBe("string");
    if (typeof r !== "string") {
      expect(r.rule.exclude).toEqual([]);
      expect(r.warnings).toHaveLength(1);
    }
  });

  it("looksLikeRedirectorExport", () => {
    expect(looksLikeRedirectorExport(REDIRECTOR_EXPORT)).toBe(true);
    expect(looksLikeRedirectorExport([{ includePattern: "x" }])).toBe(true);
    expect(looksLikeRedirectorExport({ app: "reroute", rules: [] })).toBe(false);
  });
});

describe("share links", () => {
  it("round-trips rules through reroute://import#", () => {
    const rules = [
      createRule({
        id: "a",
        name: "Ünïcode name",
        include: "https://a/*",
        redirectTo: "https://b/$1",
      }),
      createRule({
        id: "b",
        matchType: "regex",
        include: "^x(.*)$",
        redirectTo: "https://y/$1",
        transforms: ["upper"],
        enabled: false,
      }),
    ];
    const link = encodeShareLink(rules);
    expect(isShareLink(link)).toBe(true);
    expect(link).toMatch(/^reroute:\/\/import#[A-Za-z0-9_-]+$/);
    const decoded = decodeShareLink(link);
    expect(decoded.errors).toEqual([]);
    expect(decoded.rules).toHaveLength(2);
    // ids are regenerated; everything else is identical
    const strip = (r: object) => ({ ...r, id: undefined });
    expect(decoded.rules.map(strip)).toEqual(rules.map(strip));
    expect(decoded.rules[0]!.id).not.toBe("a");
  });
  it("rejects garbage", () => {
    expect(decodeShareLink("https://example.com").errors).toHaveLength(1);
    expect(decodeShareLink("reroute://import#%%%").errors).toHaveLength(1);
    expect(isShareLink("nope")).toBe(false);
  });
});

describe("rule packs", () => {
  it("ships three valid packs", () => {
    expect(RULE_PACKS.map((p) => p.id)).toEqual([
      "old-reddit",
      "privacy-frontends",
      "amp-to-canonical",
    ]);
    for (const pack of RULE_PACKS) {
      const vars: Record<string, string> = {};
      for (const v of pack.variables) vars[v.key] = "instance.example";
      const { rules, errors } = instantiatePack(pack, vars);
      expect(errors, pack.id).toEqual([]);
      expect(rules.length).toBeGreaterThan(0);
      for (const r of rules) {
        expect(r.name.startsWith(pack.name)).toBe(true);
        expect(r.redirectTo).not.toContain("{{");
      }
      // Every pack compiles (some rules are JS-only, which is fine).
      expect(() => compileToDNR(rules, 1)).not.toThrow();
    }
  });

  it("Old Reddit pack redirects and excludes correctly", () => {
    const pack = RULE_PACKS.find((p) => p.id === "old-reddit")!;
    const [r] = instantiatePack(pack).rules;
    expect(matchRule("https://www.reddit.com/r/programming/comments/abc/x/", r!)).toBe(
      "https://old.reddit.com/r/programming/comments/abc/x/",
    );
    expect(matchRule("https://reddit.com/", r!)).toBe("https://old.reddit.com/");
    expect(matchRule("https://www.reddit.com/media?url=x", r!)).toBeNull();
    expect(matchRule("https://old.reddit.com/r/x", r!)).toBeNull();
  });

  it("privacy pack requires hosts and fills them in", () => {
    const pack = RULE_PACKS.find((p) => p.id === "privacy-frontends")!;
    expect(missingVariables(pack, {})).toEqual(["INVIDIOUS_HOST", "NITTER_HOST"]);
    expect(missingVariables(pack, { INVIDIOUS_HOST: "a", NITTER_HOST: "b" })).toEqual([]);
    const { rules } = instantiatePack(pack, {
      INVIDIOUS_HOST: "inv.example",
      NITTER_HOST: "nit.example",
    });
    expect(matchRule("https://www.youtube.com/watch?v=abc", rules[0]!)).toBe(
      "https://inv.example/watch?v=abc",
    );
    expect(matchRule("https://youtu.be/abc123?si=x", rules[1]!)).toBe(
      "https://inv.example/watch?v=abc123",
    );
    expect(matchRule("https://x.com/user/status/1", rules[2]!)).toBe(
      "https://nit.example/user/status/1",
    );
    expect(fillPlaceholders("{{A}}-{{B}}", { A: "1" })).toBe("1-{{B}}");
  });

  it("AMP pack unwraps Google AMP viewer and ampproject CDN", () => {
    const pack = RULE_PACKS.find((p) => p.id === "amp-to-canonical")!;
    const { rules } = instantiatePack(pack);
    expect(
      matchRule("https://www.google.com/amp/s/www.example.com/news/story.amp", rules[0]!),
    ).toBe("https://www.example.com/news/story.amp");
    expect(
      matchRule("https://www-example-com.cdn.ampproject.org/c/s/www.example.com/a?x=1", rules[1]!),
    ).toBe("https://www.example.com/a?x=1");
    expect(rules[2]!.enabled).toBe(false);
    const enabled = { ...rules[2]!, enabled: true };
    expect(matchRule("https://news.example/story/amp?utm=1", enabled)).toBe(
      "https://news.example/story?utm=1",
    );
    expect(matchRule("https://news.example/story", enabled)).toBeNull();
    // The two enabled AMP rules are RE2-safe and become DNR rules.
    const { dnrRules, jsOnlyRuleIds } = compileToDNR(rules, 1);
    expect(dnrRules).toHaveLength(2);
    expect(jsOnlyRuleIds).toEqual([]);
  });
});

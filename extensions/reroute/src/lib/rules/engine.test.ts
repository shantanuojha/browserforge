import { describe, expect, it } from "vitest";
import { DNR_PRIORITY } from "../dnr";
import {
  allowlistToDNR,
  anchorForDNR,
  applyTransforms,
  appliesToNavigation,
  compileToDNR,
  countCaptureGroups,
  dnrIneligibilityReason,
  firstMatch,
  isRE2Compatible,
  matchRule,
  matchRuleDetailed,
  substitute,
  testUrl,
  toRegexSubstitution,
  wildcardToRegex,
  wouldLoop,
} from "./engine";
import { checkRE2Compatible } from "./re2";
import { createRule, type Rule } from "./model";

const rule = (p: Partial<Rule>): Rule => createRule({ id: p.id ?? "t", name: "test", ...p });

describe("wildcardToRegex", () => {
  it("escapes regex specials and anchors", () => {
    expect(wildcardToRegex("https://example.com/path?x=1")).toBe(
      "^https://example\\.com/path\\?x=1$",
    );
  });
  it("turns each * into a capture group", () => {
    expect(wildcardToRegex("https://*.example.com/*")).toBe("^https://(.*)\\.example\\.com/(.*)$");
  });
  it("matches Redirector fixture: http://example.com/* -> https", () => {
    const re = new RegExp(wildcardToRegex("http://example.com/*"), "i");
    const m = re.exec("http://example.com/some/page?q=1");
    expect(m?.[1]).toBe("some/page?q=1");
  });
  it("does not match beyond the anchored pattern", () => {
    const re = new RegExp(wildcardToRegex("https://example.com/"), "i");
    expect(re.test("https://example.com/extra")).toBe(false);
    expect(re.test("https://example.com/")).toBe(true);
  });
});

describe("countCaptureGroups", () => {
  it("counts plain groups only", () => {
    expect(countCaptureGroups("(a)(?:b)(c)")).toBe(2);
    expect(countCaptureGroups("\\((a)")).toBe(1);
    expect(countCaptureGroups("[(](a)")).toBe(1);
    expect(countCaptureGroups("(?<n>a)")).toBe(1);
    expect(countCaptureGroups("(?<=a)(b)")).toBe(1);
    expect(countCaptureGroups("no groups")).toBe(0);
  });
});

describe("applyTransforms", () => {
  it("decodeURIComponent", () => {
    expect(applyTransforms("https%3A%2F%2Fa.b%2Fc%3Fd%3D1", ["decodeURIComponent"])).toBe(
      "https://a.b/c?d=1",
    );
  });
  it("encodeURIComponent", () => {
    expect(applyTransforms("a b&c", ["encodeURIComponent"])).toBe("a%20b%26c");
  });
  it("atob (standard and url-safe, unpadded, utf-8)", () => {
    expect(applyTransforms("aHR0cHM6Ly9leGFtcGxlLmNvbQ==", ["atob"])).toBe("https://example.com");
    expect(applyTransforms("aHR0cHM6Ly9leGFtcGxlLmNvbQ", ["atob"])).toBe("https://example.com");
    expect(applyTransforms("w7xiZXI_", ["atob"])).toBe("über?");
  });
  it("btoa (utf-8 safe)", () => {
    expect(applyTransforms("https://example.com", ["btoa"])).toBe("aHR0cHM6Ly9leGFtcGxlLmNvbQ==");
    expect(applyTransforms("über", ["btoa"])).toBe("w7xiZXI=");
  });
  it("lower / upper", () => {
    expect(applyTransforms("MiXeD", ["lower"])).toBe("mixed");
    expect(applyTransforms("MiXeD", ["upper"])).toBe("MIXED");
  });
  it("chains in order", () => {
    expect(applyTransforms("a%20B", ["decodeURIComponent", "upper", "encodeURIComponent"])).toBe(
      "A%20B",
    );
  });
  it("throws on malformed input", () => {
    expect(() => applyTransforms("%E0%A4%A", ["decodeURIComponent"])).toThrow();
    expect(() => applyTransforms("!!!", ["atob"])).toThrow();
  });
  it("is identity for no transforms", () => {
    expect(applyTransforms("x", [])).toBe("x");
  });
});

describe("substitute", () => {
  it("replaces $1..$9 and leaves other dollars alone", () => {
    expect(substitute("https://x/$1/$2?$3", ["a", "b"])).toBe("https://x/a/b?");
    expect(substitute("price$ $0 $a $1", ["v"])).toBe("price$ $0 $a v");
  });
});

describe("matchRule", () => {
  it("wildcard with capture (Redirector http -> https example)", () => {
    const r = rule({
      matchType: "wildcard",
      include: "http://example.com/*",
      redirectTo: "https://example.com/$1",
    });
    expect(matchRule("http://example.com/a/b?c=d", r)).toBe("https://example.com/a/b?c=d");
    expect(matchRule("https://example.com/a", r)).toBeNull();
  });

  it("regex, unanchored, matches anywhere (YouTube Shorts -> watch)", () => {
    const r = rule({
      matchType: "regex",
      include: "youtube\\.com/shorts/([\\w-]+)",
      redirectTo: "https://www.youtube.com/watch?v=$1",
    });
    expect(matchRule("https://www.youtube.com/shorts/abc_D-1?feature=share", r)).toBe(
      "https://www.youtube.com/watch?v=abc_D-1",
    );
  });

  it("is case-insensitive like Redirector", () => {
    const r = rule({
      matchType: "wildcard",
      include: "https://EXAMPLE.com/*",
      redirectTo: "https://other.example/$1",
    });
    expect(matchRule("https://example.COM/x", r)).toBe("https://other.example/x");
  });

  it("applies transforms to captures (Redirector google 'url?q=' example)", () => {
    const r = rule({
      matchType: "regex",
      include: "^https://www\\.google\\.com/url\\?.*?q=([^&]+)",
      redirectTo: "$1",
      transforms: ["decodeURIComponent"],
    });
    expect(
      matchRule("https://www.google.com/url?sa=t&q=https%3A%2F%2Fexample.com%2Fp&x=1", r),
    ).toBe("https://example.com/p");
  });

  it("base64 transform example", () => {
    const r = rule({
      matchType: "regex",
      include: "^https://go\\.example/\\?t=([A-Za-z0-9_=-]+)",
      redirectTo: "$1",
      transforms: ["atob"],
    });
    expect(matchRule("https://go.example/?t=aHR0cHM6Ly9leGFtcGxlLmNvbQ==", r)).toBe(
      "https://example.com",
    );
  });

  it("honours excludes (wildcard)", () => {
    const r = rule({
      matchType: "wildcard",
      include: "https://old.example/*",
      exclude: ["https://old.example/keep/*"],
      redirectTo: "https://new.example/$1",
    });
    expect(matchRule("https://old.example/page", r)).toBe("https://new.example/page");
    expect(matchRule("https://old.example/keep/this", r)).toBeNull();
  });

  it("honours excludes (regex)", () => {
    const r = rule({
      matchType: "regex",
      include: "^https://old\\.example/(.*)$",
      exclude: ["/login", "/api/"],
      redirectTo: "https://new.example/$1",
    });
    expect(matchRule("https://old.example/api/x", r)).toBeNull();
    expect(matchRule("https://old.example/login", r)).toBeNull();
    expect(matchRule("https://old.example/home", r)).toBe("https://new.example/home");
  });

  it("returns null when disabled, on transform failure, on invalid target, or no-op", () => {
    expect(
      matchRule(
        "https://a.example/x",
        rule({
          enabled: false,
          include: "https://a.example/*",
          redirectTo: "https://b.example/$1",
        }),
      ),
    ).toBeNull();
    expect(
      matchRule(
        "https://a.example/%E0%A4%A",
        rule({
          matchType: "regex",
          include: "^https://a\\.example/(.*)$",
          redirectTo: "https://b.example/$1",
          transforms: ["decodeURIComponent"],
        }),
      ),
    ).toBeNull();
    expect(
      matchRule(
        "https://a.example/x",
        rule({ include: "https://a.example/*", redirectTo: "not a url $1" }),
      ),
    ).toBeNull();
    expect(
      matchRule(
        "https://a.example/x",
        rule({ include: "https://a.example/*", redirectTo: "https://a.example/$1" }),
      ),
    ).toBeNull();
  });

  it("treats invalid regex as non-matching", () => {
    const r = { ...rule({ matchType: "regex", include: "(", redirectTo: "https://x/" }) };
    expect(matchRule("https://a/", r)).toBeNull();
  });

  it("returns groups in detail", () => {
    const d = matchRuleDetailed(
      "https://a.example/p/q",
      rule({ include: "https://*.example/*/*", redirectTo: "https://$1.other/$3/$2" }),
    );
    expect(d).toEqual({ target: "https://a.other/q/p", groups: ["a", "p", "q"] });
  });
});

describe("firstMatch / testUrl", () => {
  const rules: Rule[] = [
    rule({
      id: "1",
      include: "https://a.example/skip/*",
      exclude: ["https://a.example/skip/no"],
      redirectTo: "https://one.example/$1",
    }),
    rule({ id: "2", include: "https://a.example/*", redirectTo: "https://two.example/$1" }),
    rule({
      id: "3",
      enabled: false,
      include: "https://a.example/*",
      redirectTo: "https://three.example/$1",
    }),
    rule({
      id: "4",
      include: "https://img.example/*",
      redirectTo: "https://cdn.example/$1",
      applyTo: "all",
      resourceTypes: ["image"],
    }),
  ];
  it("first rule in order wins", () => {
    const m = firstMatch("https://a.example/skip/yes", rules);
    expect(m?.rule.id).toBe("1");
    expect(m?.index).toBe(0);
    expect(m?.target).toBe("https://one.example/yes");
  });
  it("excluded rule falls through to the next rule", () => {
    expect(firstMatch("https://a.example/skip/no", rules)?.rule.id).toBe("2");
  });
  it("skips disabled rules and returns null when nothing matches", () => {
    expect(firstMatch("https://zzz.example/", rules)).toBeNull();
  });
  it("testUrl navigationOnly ignores image-only rules", () => {
    expect(testUrl("https://img.example/x.png", rules)?.rule.id).toBe("4");
    expect(testUrl("https://img.example/x.png", rules, { navigationOnly: true })).toBeNull();
    expect(appliesToNavigation(rules[3]!)).toBe(false);
    expect(appliesToNavigation(rule({ applyTo: "all", resourceTypes: [] }))).toBe(true);
  });
});

describe("RE2 compatibility", () => {
  it("accepts the common safe subset", () => {
    for (const src of [
      "^https?://(?:www\\.)?youtube\\.com/shorts/([\\w-]+)",
      "^https://(.*)\\.example\\.com/(.*)$",
      "[a-z0-9-]+\\.example\\.(com|org)",
      "\\bfoo\\b",
      "a{2,3}b*?c+?d?",
      "\\d+\\s\\S\\w\\W\\D",
      "x\\/y\\.z",
    ]) {
      expect(isRE2Compatible(src), src).toBe(true);
    }
  });
  it("rejects lookahead, lookbehind, backreferences, named groups, possessives, unicode props", () => {
    expect(checkRE2Compatible("a(?=b)").reason).toBe("lookahead");
    expect(checkRE2Compatible("a(?!b)").reason).toBe("lookahead");
    expect(checkRE2Compatible("(?<=a)b").reason).toBe("lookbehind");
    expect(checkRE2Compatible("(?<!a)b").reason).toBe("lookbehind");
    expect(checkRE2Compatible("(a)\\1").reason).toBe("backreference");
    expect(checkRE2Compatible("(?<name>a)").reason).toBe("named group");
    expect(checkRE2Compatible("(?<name>a)\\k<name>").reason).toBe("named group");
    expect(checkRE2Compatible("\\p{L}+").reason).toBe("unicode property escape");
    expect(checkRE2Compatible("a*+").ok).toBe(false);
    expect(checkRE2Compatible("caf\u00e9").reason).toBe("non-ASCII character");
    expect(checkRE2Compatible("(").ok).toBe(false);
    expect(checkRE2Compatible("").ok).toBe(false);
    expect(checkRE2Compatible("\\u0041").reason).toBe("\\u escape");
  });
  it("does not treat escaped or classed characters as syntax", () => {
    expect(isRE2Compatible("\\(?=x")).toBe(true);
    expect(isRE2Compatible("[(?=]")).toBe(true);
    expect(isRE2Compatible("[\\1]")).toBe(true);
  });
});

describe("DNR compilation", () => {
  it("anchorForDNR wraps unanchored patterns so the whole URL is replaced", () => {
    expect(anchorForDNR("^a$")).toBe("^a$");
    expect(anchorForDNR("a")).toBe("^.*?(?:a).*$");
    expect(anchorForDNR("^a")).toBe("(?:^a).*$");
    expect(anchorForDNR("a$")).toBe("^.*?(?:a$)");
    expect(anchorForDNR("^a\\$")).toBe("(?:^a\\$).*$");
    expect(anchorForDNR("^a\\\\$")).toBe("^a\\\\$");
  });

  it("toRegexSubstitution converts $n to \\n and rejects impossible templates", () => {
    expect(toRegexSubstitution("https://x/$1/$2", 2)).toBe("https://x/\\1/\\2");
    expect(toRegexSubstitution("https://x/$3", 2)).toBeNull();
    expect(toRegexSubstitution("https://x/\\1", 1)).toBeNull();
    expect(toRegexSubstitution("https://x/plain", 0)).toBe("https://x/plain");
  });

  it("compiles simple rules and reports JS-only ones", () => {
    const rules: Rule[] = [
      rule({ id: "w", include: "http://example.com/*", redirectTo: "https://example.com/$1" }),
      rule({
        id: "t",
        matchType: "regex",
        include: "^https://g\\.example/url\\?q=([^&]+)",
        redirectTo: "$1",
        transforms: ["decodeURIComponent"],
      }),
      rule({
        id: "x",
        include: "https://old.example/*",
        exclude: ["https://old.example/keep/*"],
        redirectTo: "https://new.example/$1",
      }),
      rule({
        id: "la",
        matchType: "regex",
        include: "^https://a\\.example/(?=x)(.*)$",
        redirectTo: "https://b.example/$1",
      }),
      rule({ id: "off", enabled: false, include: "https://q/*", redirectTo: "https://z/$1" }),
      rule({
        id: "all",
        matchType: "regex",
        include: "cdn\\.example/(.*\\.png)",
        redirectTo: "https://mirror.example/$1",
        applyTo: "all",
        resourceTypes: ["image", "sub_frame"],
      }),
      rule({
        id: "every",
        include: "https://every.example/*",
        redirectTo: "https://mirror.example/$1",
        applyTo: "all",
      }),
    ];
    const out = compileToDNR(rules, 10_000);

    expect(out.jsOnlyRuleIds).toEqual(["t", "x", "la"]);
    expect(out.jsOnlyReasons.t).toBe("uses transforms");
    expect(out.jsOnlyReasons.x).toBe("has exclude patterns");
    expect(out.jsOnlyReasons.la).toBe("regex is outside the RE2 subset");
    expect(dnrIneligibilityReason(rules[0]!)).toBeNull();

    expect(out.dnrRules.map((r) => r.id)).toEqual([10_000, 10_004, 10_005]);
    expect(out.dnrIdByRuleId).toEqual({ w: 10_000, all: 10_004, every: 10_005 });

    const first = out.dnrRules[0]!;
    expect(first).toEqual({
      id: 10_000,
      priority: DNR_PRIORITY.userRuleBase + 5, // 6 enabled rules, index 0
      condition: {
        regexFilter: "^http://example\\.com/(.*)$",
        resourceTypes: ["main_frame"],
        isUrlFilterCaseSensitive: false,
      },
      action: { type: "redirect", redirect: { regexSubstitution: "https://example.com/\\1" } },
    });

    const all = out.dnrRules[1]!;
    expect(all.condition.regexFilter).toBe("^.*?(?:cdn\\.example/(.*\\.png)).*$");
    expect(all.condition.resourceTypes).toEqual(["image", "sub_frame"]);
    expect(all.priority).toBe(DNR_PRIORITY.userRuleBase + 1);

    const every = out.dnrRules[2]!;
    expect(every.condition.resourceTypes).toContain("main_frame");
    expect(every.condition.resourceTypes).toContain("xmlhttprequest");
    expect(every.priority).toBe(DNR_PRIORITY.userRuleBase);
  });

  it("earlier rules get strictly higher priority", () => {
    const rules = [1, 2, 3].map((i) =>
      rule({
        id: String(i),
        include: `https://${i}.example/*`,
        redirectTo: "https://x.example/$1",
      }),
    );
    const { dnrRules } = compileToDNR(rules, 1);
    const prios = dnrRules.map((r) => r.priority!);
    expect(prios[0]!).toBeGreaterThan(prios[1]!);
    expect(prios[1]!).toBeGreaterThan(prios[2]!);
    expect(prios.every((p) => p >= DNR_PRIORITY.userRuleBase)).toBe(true);
  });

  it("the anchored DNR regex substitutes the same way the JS engine does", () => {
    const r = rule({
      id: "s",
      matchType: "regex",
      include: "youtube\\.com/shorts/([\\w-]+)",
      redirectTo: "https://www.youtube.com/watch?v=$1",
    });
    const { dnrRules } = compileToDNR([r], 1);
    const dnr = dnrRules[0]!;
    const url = "https://www.youtube.com/shorts/abc?x=1";
    const re = new RegExp(dnr.condition.regexFilter!, "i");
    const emulated = url.replace(re, dnr.action.redirect!.regexSubstitution!.replace(/\\1/g, "$1"));
    expect(emulated).toBe(matchRule(url, r));
  });

  it("allowlistToDNR builds one allow rule over normalised domains", () => {
    expect(allowlistToDNR([], 1)).toEqual([]);
    const [allow] = allowlistToDNR(["Example.com", "*.foo.org", "*bar.net", " .baz.io. "], 7);
    expect(allow!.id).toBe(7);
    expect(allow!.priority).toBe(DNR_PRIORITY.siteAllow);
    expect(allow!.action).toEqual({ type: "allow" });
    expect(allow!.condition.requestDomains).toEqual([
      "example.com",
      "foo.org",
      "bar.net",
      "baz.io",
    ]);
  });
});

describe("wouldLoop", () => {
  it("detects self, revisits and hop limits", () => {
    expect(wouldLoop("https://a/", "https://a/", [])).toBe(true);
    expect(wouldLoop("https://a/", "https://a/#frag", [])).toBe(true);
    expect(wouldLoop("https://a/", "https://b/", [])).toBe(false);
    expect(wouldLoop("https://a/", "https://b/", ["https://b/"])).toBe(true);
    expect(wouldLoop("https://a/", "https://c/", ["https://b/"])).toBe(false);
    const many = Array.from({ length: 8 }, (_, i) => `https://h${i}/`);
    expect(wouldLoop("https://a/", "https://z/", many)).toBe(true);
    expect(wouldLoop("https://a/", "https://z/", many.slice(0, 7))).toBe(false);
    expect(wouldLoop("https://a/", "https://z/", many, 20)).toBe(false);
  });
});

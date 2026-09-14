import { hostMatchesAny } from "@browserforge/shared";
import { describe, expect, it } from "vitest";
import { DNR_PRIORITY } from "../dnr";
import type { DnrRule } from "../dnr";
import { conditionMatches } from "../tracking/clean";
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
  isValidAbsoluteUrl,
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

/**
 * What Chrome does with a matching `regexFilter` + `regexSubstitution` rule:
 * the first match of the filter within the URL is replaced by the substitution
 * (`\N` = capture N). Returns null when the filter does not match.
 */
function emulateDnrRedirect(dnr: DnrRule, url: string): string | null {
  const filter = new RegExp(dnr.condition.regexFilter!, "i");
  if (!filter.test(url)) return null;
  const substitution = dnr.action.redirect!.regexSubstitution!.replace(/\\(\d)/g, "$$$1");
  return url.replace(filter, substitution);
}

/** Redirector 3.5.3 `_preparePattern` + `_includeMatch`, verbatim semantics, used as an oracle. */
function redirectorWildcard(pattern: string, redirectUrl: string, url: string): string | null {
  let converted = "^";
  for (const ch of pattern) {
    if ("()[]{}?.^$\\+".includes(ch)) converted += "\\" + ch;
    else if (ch === "*") converted += "(.*?)";
    else converted += ch;
  }
  converted += "$";
  const matches = new RegExp(converted, "gi").exec(url);
  if (!matches) return null;
  let out = redirectUrl;
  for (let i = matches.length - 1; i > 0; i--) {
    out = out.replace(new RegExp("\\$" + i, "gi"), matches[i] || "");
  }
  return out;
}

describe("wildcardToRegex", () => {
  it("escapes regex specials and anchors", () => {
    expect(wildcardToRegex("https://example.com/path?x=1")).toBe(
      "^https://example\\.com/path\\?x=1$",
    );
  });
  it("turns each * into a lazy capture group, like Redirector", () => {
    expect(wildcardToRegex("https://*.example.com/*")).toBe(
      "^https://(.*?)\\.example\\.com/(.*?)$",
    );
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
        regexFilter: "^http://example\\.com/(.*?)$",
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

  it("allowlistToDNR builds allow rules per pattern form over normalised hosts", () => {
    expect(allowlistToDNR([], 1)).toEqual([]);
    const rules = allowlistToDNR(["Example.com", "*.foo.org", "*bar.net", " .baz.io. "], 7);
    expect(rules.map((r) => r.id)).toEqual([7, 8, 9]);
    for (const r of rules) {
      expect(r.priority).toBe(DNR_PRIORITY.siteAllow);
      expect(r.action).toEqual({ type: "allow" });
    }
    // `*host` -> requestDomains (apex and subdomains)
    expect(rules[0]!.condition.requestDomains).toEqual(["bar.net"]);
    // exact hosts -> one regex
    expect(rules[1]!.condition.regexFilter).toContain("example\\.com|baz\\.io");
    // `*.host` -> one regex
    expect(rules[2]!.condition.regexFilter).toContain("foo\\.org");
  });
});

describe("Redirector wildcard fidelity", () => {
  const cases: [pattern: string, redirect: string, url: string][] = [
    // Multiple wildcards: Redirector's captures are lazy, so $1 is the shortest split.
    ["https://example.com/*/*", "https://x.example/$2/$1", "https://example.com/a/b/c"],
    ["https://*.example.com/*", "https://$1.other/$2", "https://a.b.example.com/p/q"],
    ["*?id=*&*", "https://x/$2?rest=$3", "https://a.example/p?id=7&x=1&y=2"],
    ["https://example.com/*", "https://x/$1", "https://example.com/only/one"],
    ["https://example.com/*-*", "https://x/$1/$2", "https://example.com/a-b-c"],
  ];
  it.each(cases)("matches Redirector for %s", (pattern, redirect, url) => {
    const r = rule({ matchType: "wildcard", include: pattern, redirectTo: redirect });
    expect(matchRule(url, r)).toBe(redirectorWildcard(pattern, redirect, url));
  });
});

describe("DNR / JS parity", () => {
  const parity = (r: Rule, url: string) => {
    const { dnrRules, jsOnlyRuleIds } = compileToDNR([r], 1);
    expect(jsOnlyRuleIds, "rule should be DNR-eligible").toEqual([]);
    expect(emulateDnrRedirect(dnrRules[0]!, url)).toBe(matchRule(url, r));
  };

  it("top-level alternation with per-branch anchors replaces the whole URL", () => {
    parity(
      rule({
        id: "alt",
        matchType: "regex",
        include: "^https://a\\.example/x|b\\.example/(.*)$",
        redirectTo: "https://c.example/$1",
      }),
      "https://www.b.example/path?q=1",
    );
    parity(
      rule({
        id: "alt2",
        matchType: "regex",
        include: "^https://a\\.example/(.*)|old\\.example/(.*)",
        redirectTo: "https://c.example/$1$2",
      }),
      "https://site.old.example/deep",
    );
    parity(
      rule({
        id: "alt3",
        matchType: "regex",
        include: "shorts/([\\w-]+)|reel/([\\w-]+)$",
        redirectTo: "https://v.example/watch?v=$1$2",
      }),
      "https://www.example.com/reel/abc",
    );
  });

  it("alternation inside groups, classes and escapes is not top-level", () => {
    expect(anchorForDNR("^(?:a|b)$")).toBe("^(?:a|b)$");
    expect(anchorForDNR("^[|]$")).toBe("^[|]$");
    expect(anchorForDNR("^a\\|b$")).toBe("^a\\|b$");
    expect(anchorForDNR("^a|b$")).toBe("^.*?(?:^a|b$).*$");
  });

  it("wildcard rules compile to the same lazy captures the JS engine uses", () => {
    parity(
      rule({ id: "w", include: "https://example.com/*/*", redirectTo: "https://x.example/$2/$1" }),
      "https://example.com/a/b/c",
    );
  });
});

describe("redirect target scheme", () => {
  it("never produces a javascript: target (tabs.update and DNR both reject it)", () => {
    expect(isValidAbsoluteUrl("javascript:alert(1)")).toBe(false);
    expect(isValidAbsoluteUrl("JavaScript:void 0")).toBe(false);
    expect(isValidAbsoluteUrl("https://a.example/")).toBe(true);
    expect(isValidAbsoluteUrl("about:blank")).toBe(true);
    expect(
      matchRule(
        "https://a.example/x",
        rule({ include: "https://a.example/*", redirectTo: "javascript:alert('$1')" }),
      ),
    ).toBeNull();
  });
});

describe("RE2 escapes that JS reads as plain letters", () => {
  it("are rejected so the rule stays on the JS path", () => {
    // In JS these are identity escapes ("A", "z", ...); in RE2 they are anchors / literals / bytes.
    for (const src of ["\\Ahttps://a", "a\\z", "\\Qa.b\\E", "a\\Cb", "\\a"]) {
      expect(checkRE2Compatible(src).ok, src).toBe(false);
    }
    expect(isRE2Compatible("\\d\\/\\.\\-\\w")).toBe(true);
  });
});

describe("allowlist DNR rules follow the same host semantics as the JS fallback", () => {
  const allowed = (patterns: string[], url: string) => {
    const host = new URL(url).hostname;
    const rules = allowlistToDNR(patterns, 1);
    return rules.some((r) => conditionMatches(r, url, host));
  };
  const cases: [patterns: string[], url: string][] = [
    [["example.com"], "https://example.com/"],
    [["example.com"], "https://www.example.com/"],
    [["example.com"], "https://example.com:8443/p?q#f"],
    [["example.com"], "https://notexample.com/"],
    [["*.example.com"], "https://example.com/"],
    [["*.example.com"], "https://a.b.example.com/"],
    [["*example.com"], "https://example.com/"],
    [["*example.com"], "https://a.example.com/"],
    [["*example.com"], "https://notexample.com/"],
    [["Example.COM", "*.Other.org"], "https://x.other.org/"],
    [["Example.COM", "*.Other.org"], "https://other.org/"],
  ];
  it.each(cases)("%j vs %s", (patterns, url) => {
    expect(allowed(patterns, url)).toBe(hostMatchesAny(new URL(url).hostname, patterns));
  });
  it("uses RE2-safe regexes and distinct ids", () => {
    const rules = allowlistToDNR(["a.example", "*.b.example", "*c.example"], 1);
    const ids = rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of rules) {
      expect(r.action).toEqual({ type: "allow" });
      expect(r.priority).toBe(DNR_PRIORITY.siteAllow);
      if (r.condition.regexFilter) expect(isRE2Compatible(r.condition.regexFilter)).toBe(true);
    }
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

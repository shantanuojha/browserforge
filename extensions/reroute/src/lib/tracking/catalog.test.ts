import { describe, expect, it } from "vitest";
import { DNR_PRIORITY } from "../dnr";
import {
  FALLBACK_PROVIDERS,
  classifyParamRules,
  expandParamRegex,
  KNOWN_PARAM_NAMES,
  literalParamName,
  parseClearUrlsCatalog,
  stripEncodedQuestionPrefix,
  toRemoveParamsRules,
  urlPatternToCondition,
} from "./catalog";
import { cleanUrl, removeQueryKeys } from "./clean";

const CATALOG = {
  providers: {
    globalRules: {
      urlPattern: ".*",
      rules: ["(?:%3F)?utm(?:_[a-z_]*)?", "(?:%3F)?fbclid", "(?:%3F)?[a-z]?mc", "(?:%3F)?gclid"],
      referralMarketing: ["(?:%3F)?ref_?"],
      exceptions: ["^https?:\\/\\/(?:[a-z0-9-]+\\.)*?github\\.com"],
    },
    amazon: {
      urlPattern: "^https?:\\/\\/(?:[a-z0-9-]+\\.)*?amazon(?:\\.[a-z]{2,}){1,}",
      rules: ["p[fd]_rd_[a-z]*", "qid", "ref_?", "[^a-z%0-9]adId", "field-lbr_brands_browse-bin"],
      rawRules: ["\\/ref=[^/?]*"],
      referralMarketing: ["tag"],
      exceptions: [
        "^https?:\\/\\/(?:[a-z0-9-]+\\.)*?amazon(?:\\.[a-z]{2,}){1,}\\/gp\\/.*?(?:redirector.html|cart\\/ajax-update.html)",
      ],
    },
    youtube: {
      urlPattern: "^https?:\\/\\/(?:[a-z0-9-]+\\.)*?(youtube\\.com|youtu\\.be)",
      rules: ["feature", "si"],
      redirections: ["^https?:\\/\\/(?:[a-z0-9-]+\\.)*?youtube\\.com\\/redirect?.*?q=([^&]*)"],
    },
    doubleclick: {
      urlPattern: "^https?:\\/\\/(?:[a-z0-9-]+\\.)*?doubleclick\\.net",
      completeProvider: true,
      rules: [],
    },
    lookahead: {
      urlPattern: "^https?:\\/\\/(?=x)weird\\.example",
      rules: ["a"],
    },
    nothing: {
      urlPattern: "^https?:\\/\\/(?:[a-z0-9-]+\\.)*?empty\\.example",
      rules: ["[^a-z]zzz"],
    },
    junk: "not a provider",
  },
};

describe("parseClearUrlsCatalog", () => {
  it("normalises providers and skips junk", () => {
    const providers = parseClearUrlsCatalog(CATALOG);
    expect(providers.map((p) => p.name)).toEqual([
      "globalRules",
      "amazon",
      "youtube",
      "doubleclick",
      "lookahead",
      "nothing",
    ]);
    const amazon = providers[1]!;
    expect(amazon.rawRules).toEqual(["\\/ref=[^/?]*"]);
    expect(amazon.referralMarketing).toEqual(["tag"]);
    expect(amazon.completeProvider).toBe(false);
    expect(providers[3]!.completeProvider).toBe(true);
    expect(providers[2]!.redirections).toHaveLength(1);
    expect(() => parseClearUrlsCatalog({})).toThrow();
  });
});

describe("parameter rule classification", () => {
  it("strips the encoded-question prefix", () => {
    expect(stripEncodedQuestionPrefix("(?:%3F)?fbclid")).toBe("fbclid");
    expect(stripEncodedQuestionPrefix("fbclid")).toBe("fbclid");
  });
  it("recognises literal names", () => {
    expect(literalParamName("fbclid")).toBe("fbclid");
    expect(literalParamName("(?:%3F)?gclid")).toBe("gclid");
    expect(literalParamName("field-lbr_brands_browse-bin")).toBe("field-lbr_brands_browse-bin");
    expect(literalParamName("utm\\.source")).toBe("utm.source");
    expect(literalParamName("utm(?:_[a-z_]*)?")).toBeNull();
    expect(literalParamName("ref_?")).toBeNull();
    expect(literalParamName("p[fd]_rd_[a-z]*")).toBeNull();
    expect(literalParamName("\\d+")).toBeNull();
    expect(literalParamName("")).toBeNull();
  });
  it("classifies and expands", () => {
    const { literal, regex } = classifyParamRules(["qid", "(?:%3F)?qid", "ref_?", "srs?"]);
    expect(literal).toEqual(["qid"]);
    expect(regex).toEqual(["ref_?", "srs?"]);
    expect(expandParamRegex("utm(?:_[a-z_]*)?", KNOWN_PARAM_NAMES)).toContain("utm_source");
    expect(expandParamRegex("utm(?:_[a-z_]*)?", KNOWN_PARAM_NAMES)).toContain("utm_campaign");
    expect(expandParamRegex("utm(?:_[a-z_]*)?", KNOWN_PARAM_NAMES)).not.toContain("fbclid");
    expect(expandParamRegex("ref_?", ["ref", "ref_", "ref_src"])).toEqual(["ref", "ref_"]);
    expect(expandParamRegex("[a-z]?mc", KNOWN_PARAM_NAMES)).toEqual(
      expect.arrayContaining(["mc", "xmc", "umc"]),
    );
    expect(expandParamRegex("(", ["a"])).toEqual([]);
  });
});

describe("urlPatternToCondition", () => {
  it("maps catch-all patterns", () => {
    expect(urlPatternToCondition(".*")).toEqual({ kind: "all" });
    expect(urlPatternToCondition("^.*$")).toEqual({ kind: "all" });
  });
  it("extracts literal hosts into requestDomains", () => {
    expect(urlPatternToCondition("^https?:\\/\\/(?:[a-z0-9-]+\\.)*?example\\.com")).toEqual({
      kind: "domains",
      requestDomains: ["example.com"],
    });
    expect(urlPatternToCondition("^https?:\\/\\/(?:www\\.)?Example\\.co\\.uk$")).toEqual({
      kind: "domains",
      requestDomains: ["example.co.uk"],
    });
    expect(
      urlPatternToCondition("^https?:\\/\\/(?:[a-z0-9-]+\\.)*?(?:youtube\\.com|youtu\\.be)"),
    ).toEqual({ kind: "domains", requestDomains: ["youtube.com", "youtu.be"] });
    expect(
      urlPatternToCondition("^https?:\\/\\/(?:[a-z0-9-]+\\.)*?(youtube\\.com|youtu\\.be)"),
    ).toEqual({ kind: "domains", requestDomains: ["youtube.com", "youtu.be"] });
    expect(urlPatternToCondition("^https?:\\/\\/example\\.com")).toEqual({
      kind: "domains",
      requestDomains: ["example.com"],
    });
  });
  it("falls back to regexFilter for TLD wildcards and paths", () => {
    const amazon = urlPatternToCondition(
      "^https?:\\/\\/(?:[a-z0-9-]+\\.)*?amazon(?:\\.[a-z]{2,}){1,}",
    );
    expect(amazon.kind).toBe("regex");
    expect(
      urlPatternToCondition("^https?:\\/\\/(?:[a-z0-9-]+\\.)*?example\\.com\\/path").kind,
    ).toBe("regex");
  });
  it("rejects non-RE2 patterns", () => {
    expect(urlPatternToCondition("^https?:\\/\\/(?=x)weird\\.example").kind).toBe("unsupported");
  });
});

describe("toRemoveParamsRules", () => {
  const providers = parseClearUrlsCatalog(CATALOG);
  const { rules, report } = toRemoveParamsRules(providers, 100);

  it("generates one removeParams rule per usable provider plus exception allow rules", () => {
    expect(report.providersTotal).toBe(6);
    expect(report.providersUsed).toBe(3);
    expect(report.providersSkipped).toEqual([
      { name: "doubleclick", reason: "completeProvider (blocking)" },
      { name: "lookahead", reason: "urlPattern is not RE2-safe" },
      { name: "nothing", reason: "no expressible parameters" },
    ]);
    expect(report.removeParamRules).toBe(3);
    expect(report.exceptionRules).toBe(2);
    expect(report.rulesGenerated).toBe(5);
    expect(rules.map((r) => r.id)).toEqual([100, 101, 102, 103, 104]);
    expect(report.rawRulesSkipped).toBe(1);
    expect(report.redirectionsSkipped).toBe(1);
    expect(report.referralMarketingSkipped).toBe(2);
    expect(report.skippedParamRegexes).toEqual([
      { provider: "amazon", regex: "[^a-z%0-9]adId" },
      { provider: "nothing", regex: "[^a-z]zzz" },
    ]);
  });

  it("shapes rules correctly", () => {
    const global = rules[0]!;
    expect(global.priority).toBe(DNR_PRIORITY.tracking);
    expect(global.condition).toEqual({ resourceTypes: ["main_frame", "sub_frame"] });
    const params = global.action.redirect!.transform!.queryTransform!.removeParams!;
    expect(params).toContain("fbclid");
    expect(params).toContain("gclid");
    expect(params).toContain("utm_source");
    expect(params).toContain("mc");
    expect(params).not.toContain("ref"); // referralMarketing is skipped
    expect([...params].sort()).toEqual(params);

    const githubException = rules[1]!;
    expect(githubException.action).toEqual({ type: "allow" });
    expect(githubException.priority).toBe(DNR_PRIORITY.trackingException);
    expect(githubException.condition.regexFilter).toContain("github");

    const amazon = rules[2]!;
    expect(amazon.condition.regexFilter).toBeDefined();
    expect(amazon.condition.isUrlFilterCaseSensitive).toBe(false);
    const amazonParams = amazon.action.redirect!.transform!.queryTransform!.removeParams!;
    expect(amazonParams).toEqual(
      expect.arrayContaining([
        "qid",
        "ref",
        "ref_",
        "pf_rd_r",
        "pd_rd_w",
        "field-lbr_brands_browse-bin",
      ]),
    );
    expect(amazonParams).not.toContain("tag");

    const youtube = rules[4]!;
    expect(youtube.condition.requestDomains).toEqual(["youtube.com", "youtu.be"]);
    expect(youtube.condition.regexFilter).toBeUndefined();
    expect(youtube.action.redirect!.transform!.queryTransform!.removeParams).toEqual([
      "feature",
      "si",
    ]);

    expect(report.regexRules).toBe(3); // amazon filter + 2 exceptions
  });

  it("uses literal names from the whole catalog as expansion candidates", () => {
    const { rules: r } = toRemoveParamsRules(
      parseClearUrlsCatalog({
        providers: {
          a: { urlPattern: ".*", rules: ["zzq_[a-z]+"] },
          b: { urlPattern: "^https?:\\/\\/b\\.example", rules: ["zzq_thing"] },
        },
      }),
    );
    expect(r[0]!.action.redirect!.transform!.queryTransform!.removeParams).toEqual(["zzq_thing"]);
  });

  it("can omit exceptions and honours extra candidates", () => {
    const { rules: r, report: rep } = toRemoveParamsRules(providers, 1, {
      includeExceptions: false,
      extraCandidates: ["utm_zzz"],
    });
    expect(rep.exceptionRules).toBe(0);
    expect(r.every((x) => x.action.type === "redirect")).toBe(true);
    expect(r[0]!.action.redirect!.transform!.queryTransform!.removeParams).toContain("utm_zzz");
  });

  it("fallback providers produce a usable ruleset", () => {
    const { rules: fb, report: rep } = toRemoveParamsRules(FALLBACK_PROVIDERS);
    expect(rep.providersUsed).toBe(2);
    expect(cleanUrl("https://example.com/?utm_source=a&fbclid=b&keep=1", fb).url).toBe(
      "https://example.com/?keep=1",
    );
  });
});

describe("cleanUrl (JS evaluator)", () => {
  const { rules } = toRemoveParamsRules(parseClearUrlsCatalog(CATALOG));

  it("removes global params anywhere", () => {
    const r = cleanUrl(
      "https://news.example/story?id=7&utm_source=tw&utm_medium=social&fbclid=x",
      rules,
    );
    expect(r.url).toBe("https://news.example/story?id=7");
    expect(r.removed).toEqual(["utm_source", "utm_medium", "fbclid"]);
    expect(r.changed).toBe(true);
  });
  it("applies provider params only on that provider", () => {
    expect(cleanUrl("https://www.youtube.com/watch?v=abc&si=xyz&feature=share", rules).url).toBe(
      "https://www.youtube.com/watch?v=abc",
    );
    expect(cleanUrl("https://youtu.be/abc?si=xyz", rules).url).toBe("https://youtu.be/abc");
    expect(cleanUrl("https://other.example/?si=keep", rules).changed).toBe(false);
    expect(cleanUrl("https://www.amazon.co.uk/dp/B0?qid=1&ref_=x&tag=aff&keep=1", rules).url).toBe(
      "https://www.amazon.co.uk/dp/B0?tag=aff&keep=1",
    );
  });
  it("honours exceptions (allow rules)", () => {
    expect(cleanUrl("https://github.com/x/y?utm_source=z", rules).changed).toBe(false);
    expect(
      cleanUrl("https://www.amazon.com/gp/redirector.html?qid=1&utm_source=z", rules).changed,
    ).toBe(false);
  });
  it("preserves the fragment and untouched encoding; drops the ? when empty", () => {
    expect(cleanUrl("https://a.example/p?utm_source=x#sec", rules).url).toBe(
      "https://a.example/p#sec",
    );
    expect(cleanUrl("https://a.example/p?q=a%20b+c&utm_source=x", rules).url).toBe(
      "https://a.example/p?q=a%20b+c",
    );
    expect(cleanUrl("https://a.example/p?%75tm_source=x&k=1", rules).url).toBe(
      "https://a.example/p?k=1",
    );
  });
  it("ignores non-http and query-less URLs", () => {
    expect(cleanUrl("ftp://a.example/?utm_source=1", rules).changed).toBe(false);
    expect(cleanUrl("https://a.example/", rules).changed).toBe(false);
    expect(cleanUrl("not a url", rules).changed).toBe(false);
  });
  it("removeQueryKeys handles bare keys and duplicates", () => {
    expect(removeQueryKeys("https://a/?x&utm_source&x=2", new Set(["utm_source"])).url).toBe(
      "https://a/?x&x=2",
    );
    expect(removeQueryKeys("https://a/?", new Set(["x"])).changed).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  addHostToAllowlist,
  isHostAllowlisted,
  isUrlAllowlisted,
  normalizeAllowlistEntry,
  removeHostFromAllowlist,
} from "./allowlist";
import { analyseImportText } from "./import-analysis";
import { createRule } from "./model";
import { encodeShareLink } from "./share";
import { parseExcludeLines, validateRuleDraft } from "./validate";

describe("allowlist", () => {
  it("normalises user input to a host pattern and rejects junk", () => {
    expect(normalizeAllowlistEntry(" HTTPS://Example.com/path ")).toBe("example.com");
    expect(normalizeAllowlistEntry("*.example.com")).toBe("*.example.com");
    expect(normalizeAllowlistEntry("")).toBeNull();
    expect(normalizeAllowlistEntry("not a host")).toBeNull();
  });

  it("matches hosts and URLs with the shared pattern semantics", () => {
    expect(isHostAllowlisted("a.example.com", ["*example.com"])).toBe(true);
    expect(isHostAllowlisted("example.com", [])).toBe(false);
    expect(isUrlAllowlisted("https://a.example.com/x", ["*.example.com"])).toBe(true);
    expect(isUrlAllowlisted("not a url", ["*"])).toBe(false);
  });

  it("adds a host once and removes every pattern that covers it", () => {
    expect(addHostToAllowlist(["a.example"], "a.example")).toEqual(["a.example"]);
    expect(addHostToAllowlist([], "a.example")).toEqual(["a.example"]);
    expect(
      removeHostFromAllowlist(
        ["*example.com", "other.example", "www.example.com"],
        "www.example.com",
      ),
    ).toEqual(["other.example"]);
  });
});

describe("rule draft validation", () => {
  it("requires include and target and checks regex syntax", () => {
    expect(validateRuleDraft(createRule())).toEqual([
      "Include pattern is required.",
      "Redirect target is required.",
    ]);
    const regex = createRule({
      matchType: "regex",
      include: "(",
      redirectTo: "https://t/",
      exclude: ["["],
    });
    expect(validateRuleDraft(regex)).toEqual([
      "Include pattern is not a valid regular expression.",
      'Exclude "[" is not a valid regular expression.',
    ]);
    expect(validateRuleDraft(createRule({ include: "(", redirectTo: "https://t/" }))).toEqual([]);
  });

  it("splits exclude lines and drops blanks", () => {
    expect(parseExcludeLines(" a \n\n b\n")).toEqual(["a", "b"]);
  });
});

describe("analyseImportText", () => {
  const rules = [createRule({ id: "r", include: "https://a/*", redirectTo: "https://b/$1" })];

  it("recognises share links, Redirector exports and Reroute JSON", () => {
    expect(analyseImportText("   ")).toBeNull();
    expect(analyseImportText(encodeShareLink(rules))?.source).toBe("Reroute share link");
    const redirector = {
      createdBy: "Redirector v3.5.3",
      redirects: [{ includePattern: "a*", redirectUrl: "b" }],
    };
    expect(analyseImportText(JSON.stringify(redirector))).toMatchObject({
      source: "Redirector v3.5.3",
      rules: [expect.objectContaining({ include: "a*" })],
    });
    expect(analyseImportText(JSON.stringify(rules))).toMatchObject({ source: "Reroute JSON" });
  });

  it("reports invalid JSON as an error instead of throwing", () => {
    const preview = analyseImportText("{ nope");
    expect(preview?.rules).toEqual([]);
    expect(preview?.errors[0]).toMatch(/Not valid JSON/);
  });
});

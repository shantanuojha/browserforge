import { describe, expect, it } from "vitest";
import {
  appendRules,
  createRule,
  describeRule,
  generateRuleId,
  parseRule,
  parseRules,
  parseRulesJson,
  serializeRules,
  toRuleSetDocument,
} from "./model";

describe("model", () => {
  it("createRule fills defaults and generates ids", () => {
    const r = createRule({ include: "https://a/*", redirectTo: "https://b/$1" });
    expect(r.id).toMatch(/^r_[0-9a-f]{12}$/);
    expect(r.enabled).toBe(true);
    expect(r.matchType).toBe("wildcard");
    expect(r.exclude).toEqual([]);
    expect(r.transforms).toEqual([]);
    expect(r.applyTo).toBe("navigation");
    expect(generateRuleId()).not.toBe(generateRuleId());
  });

  it("parseRule validates each field", () => {
    expect(parseRule(null).ok).toBe(false);
    expect(parseRule({}).ok).toBe(false); // include missing
    expect(parseRule({ include: "x", redirectTo: 1 }).ok).toBe(false);
    expect(parseRule({ include: "x", redirectTo: "y", matchType: "glob" }).ok).toBe(false);
    expect(parseRule({ include: "x", redirectTo: "y", transforms: ["md5"] }).ok).toBe(false);
    expect(parseRule({ include: "x", redirectTo: "y", resourceTypes: ["nope"] }).ok).toBe(false);
    expect(parseRule({ include: "x", redirectTo: "y", applyTo: "sometimes" }).ok).toBe(false);
    expect(parseRule({ include: "x", redirectTo: "y", enabled: "yes" }).ok).toBe(false);
    expect(parseRule({ include: "(", redirectTo: "y", matchType: "regex" }).ok).toBe(false);
    expect(parseRule({ include: "(", redirectTo: "y", matchType: "wildcard" }).ok).toBe(true);
    const bad = parseRule({ include: "x", redirectTo: "y", exclude: "no" }, 3);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("rule[3]");
  });

  it("parseRule normalises and drops unknown keys", () => {
    const res = parseRule({
      id: "abc",
      include: "https://a/*",
      redirectTo: "https://b/$1",
      exclude: ["", "https://a/keep"],
      extra: true,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({
        id: "abc",
        name: "",
        enabled: true,
        matchType: "wildcard",
        include: "https://a/*",
        exclude: ["https://a/keep"],
        redirectTo: "https://b/$1",
        resourceTypes: [],
        transforms: [],
        applyTo: "navigation",
      });
    }
  });

  it("parseRules accepts documents, arrays and single rules; dedupes ids", () => {
    const doc = parseRules({
      app: "reroute",
      version: 1,
      rules: [
        { id: "same", include: "a", redirectTo: "https://x/" },
        { id: "same", include: "b", redirectTo: "https://y/" },
        { include: 5 },
      ],
    });
    expect(doc.rules).toHaveLength(2);
    expect(doc.rules[0]!.id).toBe("same");
    expect(doc.rules[1]!.id).not.toBe("same");
    expect(doc.errors).toHaveLength(1);

    expect(parseRules([{ include: "a", redirectTo: "https://x/" }]).rules).toHaveLength(1);
    expect(parseRules({ include: "a", redirectTo: "https://x/" }).rules).toHaveLength(1);
    expect(parseRules("nope").errors).toHaveLength(1);
    expect(parseRulesJson("{").errors[0]).toMatch(/Invalid JSON/);
  });

  it("round-trips through serializeRules", () => {
    const rules = [
      createRule({ id: "1", name: "One", include: "https://a/*", redirectTo: "https://b/$1" }),
      createRule({
        id: "2",
        matchType: "regex",
        include: "^x$",
        redirectTo: "https://y/",
        transforms: ["lower"],
        applyTo: "all",
        resourceTypes: ["image"],
      }),
    ];
    const text = serializeRules(rules);
    const parsed = parseRulesJson(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rules).toEqual(rules);
    expect(toRuleSetDocument(rules).app).toBe("reroute");
  });

  it("appendRules re-ids imported rules that collide with existing ones (re-importing a backup)", () => {
    const existing = [
      createRule({ id: "a", include: "https://a/*", redirectTo: "https://b/$1" }),
      createRule({ id: "b", include: "https://b/*", redirectTo: "https://c/$1" }),
    ];
    const backup = parseRulesJson(serializeRules(existing)).rules;
    const fresh = createRule({ id: "z", include: "https://z/*", redirectTo: "https://y/$1" });
    const merged = appendRules(existing, [...backup, fresh]);
    expect(merged).toHaveLength(5);
    expect(new Set(merged.map((r) => r.id)).size).toBe(5);
    expect(merged.slice(0, 2)).toEqual(existing);
    expect(merged[4]).toBe(fresh);
    expect(merged[2]).toMatchObject({ include: "https://a/*", redirectTo: "https://b/$1" });
    expect(merged[2]!.id).not.toBe("a");
  });

  it("describeRule prefers the name", () => {
    expect(describeRule(createRule({ name: " N ", include: "a", redirectTo: "b" }))).toBe("N");
    expect(describeRule(createRule({ include: "a", redirectTo: "b" }))).toBe("a -> b");
  });
});

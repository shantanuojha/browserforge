/**
 * Sanity checks over the checked-in, generated static ruleset so a bad
 * regeneration cannot ship unnoticed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { DnrRule } from "../dnr";
import { DNR_LIMITS, DNR_PRIORITY } from "../dnr";
import { isRE2Compatible } from "../rules/re2";
import { cleanUrl } from "./clean";

const rulesPath = resolve(import.meta.dirname, "../../../public/rules/tracking-params.json");
const metaPath = resolve(import.meta.dirname, "../../../public/rules/tracking-params.meta.json");
const rules = JSON.parse(readFileSync(rulesPath, "utf8")) as DnrRule[];
const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;

describe("public/rules/tracking-params.json", () => {
  it("is a non-trivial ruleset within Chrome's static limits", () => {
    expect(rules.length).toBeGreaterThan(1);
    expect(rules.length).toBeLessThan(DNR_LIMITS.maxStaticRulesPerRuleset);
    const regexCount = rules.filter((r) => r.condition.regexFilter).length;
    expect(regexCount).toBeLessThan(DNR_LIMITS.maxRegexRules);
    expect(meta.rulesGenerated).toBe(rules.length);
    expect(meta.regexRules).toBe(regexCount);
  });

  it("has unique positive ids and only the shapes we generate", () => {
    const ids = new Set<number>();
    for (const r of rules) {
      expect(r.id).toBeGreaterThan(0);
      expect(ids.has(r.id)).toBe(false);
      ids.add(r.id);
      expect(r.condition.resourceTypes).toEqual(["main_frame", "sub_frame"]);
      if (r.condition.regexFilter) {
        expect(isRE2Compatible(r.condition.regexFilter), r.condition.regexFilter).toBe(true);
        expect(r.condition.isUrlFilterCaseSensitive).toBe(false);
      }
      if (r.action.type === "allow") {
        expect(r.priority).toBe(DNR_PRIORITY.trackingException);
      } else {
        expect(r.action.type).toBe("redirect");
        expect(r.priority).toBe(DNR_PRIORITY.tracking);
        const params = r.action.redirect?.transform?.queryTransform?.removeParams ?? [];
        expect(params.length).toBeGreaterThan(0);
        for (const p of params) expect(p).toMatch(/^[^&=#\s]+$/);
      }
    }
  });

  it("strips the classic trackers", () => {
    expect(
      cleanUrl(
        "https://example.org/article?id=42&utm_source=newsletter&utm_medium=email&utm_campaign=x&fbclid=abc&gclid=def&mc_eid=ghi",
        rules,
      ).url,
    ).toBe("https://example.org/article?id=42");
    if (meta.usedFallback !== true) {
      expect(cleanUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=abc", rules).url).toBe(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      );
      expect(cleanUrl("https://www.amazon.com/dp/B000/?qid=1&ref_=sr_1_1&th=1", rules).url).toBe(
        "https://www.amazon.com/dp/B000/",
      );
      // globalRules exception: GitHub keeps its parameters.
      expect(cleanUrl("https://github.com/o/r/pull/1?utm_source=x", rules).changed).toBe(false);
    }
  });
});

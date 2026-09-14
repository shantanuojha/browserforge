import { describe, expect, it } from "vitest";
import { DNR_ID_RANGE } from "../dnr";
import { compileToDNR } from "../rules/dnr-compiler";
import { createRule } from "../rules/model";
import { TRACKING_RULESET_ID, createRuleDeployer } from "./rule-deployer";
import { createFakeDnr, createRecordingRecorder } from "./testing";

const dnrRule = (id: string, host: string) =>
  createRule({ id, include: `https://${host}/*`, redirectTo: "https://target.example/$1" });
const jsRule = (id: string) =>
  createRule({ id, include: "https://js.example/*", exclude: ["x"], redirectTo: "https://t/$1" });

function setup() {
  const dnr = createFakeDnr();
  const recorder = createRecordingRecorder();
  return { dnr, recorder, deployer: createRuleDeployer(dnr, recorder) };
}

describe("rule deployer", () => {
  it("replaces the dynamic rules with the compiled user rules and allowlist", async () => {
    const { dnr, deployer } = setup();
    dnr.rules = [{ id: 999, condition: {}, action: { type: "allow" } }];
    const result = await deployer.deploy(
      [dnrRule("a", "a.example"), jsRule("js")],
      ["off.example"],
    );
    expect(result.dnrRuleCount).toBe(1);
    expect(result.jsOnlyRuleIds).toEqual(new Set(["js"]));
    expect(dnr.rules.map((r) => r.action.type).sort()).toEqual(["allow", "redirect"]);
    expect(dnr.rules.some((r) => r.id === 999)).toBe(false);
  });

  it("demotes a rule to the JS fallback when the engine rejects its regex", async () => {
    const { dnr, deployer } = setup();
    const rule = dnrRule("a", "a.example");
    const compiled = compileToDNR([rule], DNR_ID_RANGE.userRuleBase);
    dnr.unsupportedRegexes.add(compiled.dnrRules[0]!.condition.regexFilter!);
    const result = await deployer.deploy([rule], []);
    expect(result.jsOnlyReasons.a).toMatch(/isRegexSupported/);
    expect(result.dnrRuleCount).toBe(0);
    expect(dnr.rules).toEqual([]);
  });

  it("falls back to adding rules one by one when the batch is rejected, logging the culprit", async () => {
    const { dnr, recorder, deployer } = setup();
    dnr.rejectedIds.add(DNR_ID_RANGE.userRuleBase + 1);
    const result = await deployer.deploy(
      [dnrRule("a", "a.example"), dnrRule("b", "b.example")],
      [],
    );
    expect(result.jsOnlyReasons).toEqual({ b: "browser rejected the dynamic rule" });
    expect(result.dnrRuleCount).toBe(1);
    expect(dnr.rules.map((r) => r.id)).toEqual([DNR_ID_RANGE.userRuleBase]);
    expect(recorder.events.map((e) => e.detail)).toEqual([
      expect.stringMatching(/Dynamic rule \d+ rejected/),
    ]);
  });

  it("only toggles the tracking ruleset when its state differs", async () => {
    const { dnr, deployer } = setup();
    await deployer.setTrackingEnabled(true);
    expect(dnr.enabledRulesets).toEqual([TRACKING_RULESET_ID]);
    await deployer.setTrackingEnabled(false);
    expect(dnr.enabledRulesets).toEqual([]);
    await deployer.setTrackingEnabled(false);
    expect(dnr.enabledRulesets).toEqual([]);
  });

  it("treats every regex as supported when the browser lacks isRegexSupported", async () => {
    const dnr = createFakeDnr();
    delete (dnr as { isRegexSupported?: unknown }).isRegexSupported;
    const deployer = createRuleDeployer(dnr, createRecordingRecorder());
    await expect(
      deployer.isRegexSupported({
        id: 1,
        condition: { regexFilter: "x" },
        action: { type: "allow" },
      }),
    ).resolves.toBe(true);
  });
});

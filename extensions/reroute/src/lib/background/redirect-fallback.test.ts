import { describe, expect, it } from "vitest";
import { createRule, type Rule } from "../rules/model";
import { LOOP_WINDOW_MS, TabRedirectHistory, createRedirectFallback } from "./redirect-fallback";
import { createFakeTabs, createRecordingRecorder } from "./testing";

const rule = (id: string, extra: Partial<Rule> = {}) =>
  createRule({ id, include: "https://a.example/*", redirectTo: "https://b.example/$1", ...extra });

function setup(rules: Rule[], options: { jsOnly?: string[]; allowlist?: string[] } = {}) {
  const tabs = createFakeTabs();
  const recorder = createRecordingRecorder();
  const clock = { now: 1_000 };
  const fallback = createRedirectFallback({
    tabs,
    recorder,
    clock: () => clock.now,
    ready: Promise.resolve(),
    view: () => ({
      enabledRules: rules.filter((r) => r.enabled),
      allowlist: options.allowlist ?? [],
      jsOnlyRuleIds: new Set(options.jsOnly ?? []),
    }),
  });
  return { tabs, recorder, clock, fallback };
}

describe("redirect fallback", () => {
  it("redirects JS-only rules on navigation and records the event", async () => {
    const { tabs, recorder, fallback } = setup([rule("js")], { jsOnly: ["js"] });
    await fallback.handleNavigation(1, "https://a.example/x", "navigate");
    expect(tabs.updates).toEqual([{ tabId: 1, url: "https://b.example/x" }]);
    expect(recorder.events[0]).toMatchObject({ kind: "js", ruleId: "js", detail: "navigation" });
  });

  it("leaves DNR-handled rules alone on navigation but applies them on history-state", async () => {
    const { tabs, fallback } = setup([rule("dnr")]);
    await fallback.handleNavigation(1, "https://a.example/x", "navigate");
    expect(tabs.updates).toEqual([]);
    await fallback.handleNavigation(1, "https://a.example/x", "history");
    expect(tabs.updates).toEqual([{ tabId: 1, url: "https://b.example/x" }]);
  });

  it("ignores non-http URLs, background tabs and allowlisted sites", async () => {
    const { tabs, fallback } = setup([rule("js")], { jsOnly: ["js"], allowlist: ["a.example"] });
    await fallback.handleNavigation(-1, "https://a.example/x", "navigate");
    await fallback.handleNavigation(1, "chrome://newtab", "navigate");
    await fallback.handleNavigation(1, "https://a.example/x", "navigate");
    expect(tabs.updates).toEqual([]);
  });

  it("stops a redirect that revisits a recent target and records the loop", async () => {
    // a -> b -> a -> b: the third hop targets b again, which the tab already bounced to.
    const back = rule("back", {
      include: "https://b.example/*",
      redirectTo: "https://a.example/$1",
    });
    const { tabs, recorder, fallback } = setup([rule("js"), back], { jsOnly: ["js", "back"] });
    await fallback.handleNavigation(1, "https://a.example/x", "navigate");
    await fallback.handleNavigation(1, "https://b.example/x", "navigate");
    await fallback.handleNavigation(1, "https://a.example/x", "navigate");
    expect(tabs.updates).toHaveLength(2);
    expect(recorder.events.map((e) => e.kind)).toEqual(["js", "js", "loop"]);
  });

  it("records a failed tabs.update instead of throwing", async () => {
    const { tabs, recorder, fallback } = setup([rule("js")], { jsOnly: ["js"] });
    tabs.failUpdate = true;
    await fallback.handleNavigation(1, "https://a.example/x", "navigate");
    expect(recorder.events[0]).toMatchObject({
      kind: "error",
      detail: expect.stringMatching(/tabs.update/),
    });
  });
});

describe("TabRedirectHistory", () => {
  it("forgets targets older than the window and whole tabs on demand", () => {
    const history = new TabRedirectHistory();
    history.remember(1, "https://one/", 0);
    history.remember(1, "https://two/", 5_000);
    expect(history.recent(1, 6_000)).toEqual(["https://one/", "https://two/"]);
    expect(history.recent(1, LOOP_WINDOW_MS + 1)).toEqual(["https://two/"]);
    history.forget(1);
    expect(history.recent(1, LOOP_WINDOW_MS + 1)).toEqual([]);
  });
});

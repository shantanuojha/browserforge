import { describe, expect, it } from "vitest";
import { ADOPTION_TTL_MS, AdoptionRegistry } from "./adoption";
import type { LiveTab } from "./types";

const created = (windowId: number, pendingUrl: string): LiveTab => ({
  id: 1,
  windowId,
  index: 0,
  url: "",
  pendingUrl,
});

describe("AdoptionRegistry", () => {
  it("hands a created tab to the pending restore with the same url and window, once", () => {
    const registry = new AdoptionRegistry(() => 0);
    registry.expectTab("s", "https://s.test/", 7);
    expect(registry.claimTab(created(8, "https://s.test/"))).toBeUndefined();
    expect(registry.claimTab(created(7, "https://s.test"))?.nodeId).toBe("s");
    expect(registry.claimTab(created(7, "https://s.test/"))).toBeUndefined();
  });

  it("matches any window when the restore did not name one", () => {
    const registry = new AdoptionRegistry(() => 0);
    registry.expectTab("s", "https://s.test/", undefined);
    expect(registry.claimTab(created(3, "https://s.test/"))?.nodeId).toBe("s");
  });

  it("lets a restore that never came back expire instead of capturing a later tab", () => {
    let now = 0;
    const registry = new AdoptionRegistry(() => now);
    registry.expectTab("s", "https://s.test/", 7);
    now += ADOPTION_TTL_MS + 1;
    expect(registry.claimTab(created(7, "https://s.test/"))).toBeUndefined();
  });

  it("forgets restores by node, by handle and by window", () => {
    const registry = new AdoptionRegistry(() => 0);
    const a = registry.expectTab("a", "https://a.test/", 1);
    registry.expectTab("b", "https://b.test/", 1);
    registry.expectTab("c", "https://c.test/", 2);
    registry.forget(a);
    registry.forgetNode("b");
    expect(registry.claimTab(created(1, "https://a.test/"))).toBeUndefined();
    expect(registry.claimTab(created(1, "https://b.test/"))).toBeUndefined();
    registry.forgetWindowTabs(2);
    expect(registry.claimTab(created(2, "https://c.test/"))).toBeUndefined();
  });

  it("hands out the window adoption exactly once", () => {
    const registry = new AdoptionRegistry(() => 0);
    registry.expectWindow({ nodeId: "g", urls: ["https://s.test/"], only: undefined });
    expect(registry.takeWindow()?.nodeId).toBe("g");
    expect(registry.takeWindow()).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, type Logger } from "@browserforge/shared";
import type { ExecuteResult } from "../executor.js";
import { DEFAULT_SETTINGS, type CleanupTrigger, type Settings } from "../settings.js";
import { summarizeResults, toActivityEntries } from "./activity.js";
import {
  BADGE_COLORS,
  createBadgeController,
  flashBadge,
  siteBadge,
  type BadgeStyle,
} from "./badge.js";
import { createMessageHandler } from "./message-handler.js";
import { openTabUrlsByStore } from "./open-tabs.js";
import {
  ALARM_MIN_SECONDS,
  CLEANUP_ALARM,
  PENDING_TRIGGER_KEY,
  createCleanupScheduler,
  higherPriorityTrigger,
  type AlarmsPort,
  type SessionStore,
} from "./scheduler.js";
import { createStoreRegistry } from "./store-registry.js";
import { TabHostTracker } from "./tab-hosts.js";

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };

const result = (partial: Partial<ExecuteResult> & { storeId: string }): ExecuteResult => ({
  domains: [],
  cookiesRemoved: 0,
  cookiesFailed: 0,
  siteDataDomains: 0,
  siteDataFailed: false,
  siteDataMode: "none",
  ...partial,
});

describe("activity", () => {
  it("summarises totals and lists only domains where something was removed", () => {
    const results = [
      result({ storeId: "0", domains: ["a.com"], cookiesRemoved: 2 }),
      result({ storeId: "1", domains: ["b.com"], siteDataDomains: 1 }),
      result({ storeId: "2", domains: ["nothing.com"] }),
    ];
    expect(summarizeResults(results)).toEqual({
      cookiesRemoved: 2,
      siteDataDomains: 1,
      domains: ["a.com", "b.com"],
    });
    const entries = toActivityEntries("tab-close", results, 1_000, () => "id");
    expect(entries.map((e) => e.storeId)).toEqual(["0", "1"]);
    expect(entries[0]).toMatchObject({ id: "id", at: 1_000, trigger: "tab-close" });
  });
});

describe("openTabUrlsByStore", () => {
  it("attributes committed and pending URLs to the owning store", () => {
    const tabs = [
      { id: 1, url: "https://a/", pendingUrl: "https://b/" },
      { id: 2, url: "https://c/" },
      { id: 3 },
    ];
    const stores = [
      { id: "0", tabIds: [1] },
      { id: "1", tabIds: [2, 3] },
    ];
    expect(openTabUrlsByStore(tabs, stores)).toEqual({
      "0": ["https://a/", "https://b/"],
      "1": ["https://c/"],
    });
  });

  it("protects tabs the browser did not attribute to any store in every store", () => {
    const tabs = [{ id: 9, url: "https://orphan/" }];
    const stores = [
      { id: "0", tabIds: [] },
      { id: "1", tabIds: [] },
    ];
    expect(openTabUrlsByStore(tabs, stores)).toEqual({
      "0": ["https://orphan/"],
      "1": ["https://orphan/"],
    });
  });
});

describe("TabHostTracker", () => {
  it("schedules for new tabs and site changes but not same-site navigation", () => {
    const tracker = new TabHostTracker();
    expect(tracker.commit(1, "news.site")).toBe(true);
    expect(tracker.commit(1, "www.news.site")).toBe(false);
    expect(tracker.commit(1, "other.example")).toBe(true);
    expect(tracker.commit(1, null)).toBe(true);
    expect(tracker.commit(1, "back.example")).toBe(false);
  });

  it("prime learns unknown tabs only", () => {
    const tracker = new TabHostTracker();
    tracker.commit(1, "known.site");
    tracker.prime([
      { id: 1, url: "https://changed.site/" },
      { id: 2, url: "https://new.site/" },
    ]);
    expect(tracker.commit(1, "known.site")).toBe(false);
    expect(tracker.commit(2, "new.site")).toBe(false);
  });
});

describe("badge presentation", () => {
  it("encodes paused, listed and plain states", () => {
    expect(siteBadge({ enabled: true, host: null, listType: null, cookieCount: 3 })).toEqual({
      text: "",
      color: BADGE_COLORS.default,
    });
    expect(siteBadge({ enabled: false, host: "a", listType: null, cookieCount: 3 })).toEqual({
      text: "off",
      color: BADGE_COLORS.paused,
    });
    expect(siteBadge({ enabled: true, host: "a", listType: "white", cookieCount: 3 })).toEqual({
      text: "3",
      color: BADGE_COLORS.white,
    });
    expect(siteBadge({ enabled: true, host: "a", listType: "grey", cookieCount: 0 }).color).toBe(
      BADGE_COLORS.grey,
    );
    expect(flashBadge(4)).toEqual({ text: "-4", color: BADGE_COLORS.flash });
  });
});

describe("badge controller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(settings: Partial<Settings> = {}) {
    const painted: { tabId: number; style: BadgeStyle }[] = [];
    const controller = createBadgeController({
      painter: { paint: async (tabId, style) => void painted.push({ tabId, style }) },
      resolveTab: async (tabId) => ({ id: tabId ?? 7, url: "https://shop.example/x" }),
      storeIdForTab: async () => "0",
      countCookies: async () => 5,
      loadSettings: async () => ({ ...DEFAULT_SETTINGS, lists: [], ...settings }),
      logger: quiet,
      flashMs: 50,
      debounceMs: 20,
    });
    return { painted, controller };
  }

  it("paints the cookie count for the active site", async () => {
    const { painted, controller } = setup({
      lists: [{ pattern: "*shop.example", listType: "grey" }],
    });
    await controller.refresh();
    expect(painted).toEqual([{ tabId: 7, style: { text: "5", color: BADGE_COLORS.grey } }]);
  });

  it("flashes the removed count and then goes back to the normal badge", async () => {
    const { painted, controller } = setup();
    await controller.flash(2);
    expect(painted.at(-1)?.style.text).toBe("-2");
    await vi.advanceTimersByTimeAsync(60);
    expect(painted.at(-1)?.style.text).toBe("5");
  });

  it("coalesces debounced refreshes", async () => {
    const { painted, controller } = setup();
    controller.refreshDebounced();
    controller.refreshDebounced();
    controller.refreshDebounced();
    await vi.advanceTimersByTimeAsync(30);
    expect(painted).toHaveLength(1);
  });
});

describe("scheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("startup outranks manual which outranks tab events when triggers merge", () => {
    expect(higherPriorityTrigger(undefined, "tab-close")).toBe("tab-close");
    expect(higherPriorityTrigger("tab-close", "domain-change")).toBe("tab-close");
    expect(higherPriorityTrigger("tab-close", "manual")).toBe("manual");
    expect(higherPriorityTrigger("startup", "manual")).toBe("startup");
  });

  function setup(settings: Partial<Settings>) {
    const session = new Map<string, unknown>();
    const alarms: string[] = [];
    const runs: CleanupTrigger[] = [];
    const sessionStore: SessionStore = {
      get: async <T>(key: string) => session.get(key) as T | undefined,
      set: async (key, value) =>
        void (value === undefined ? session.delete(key) : session.set(key, value)),
    };
    const alarmsPort: AlarmsPort = {
      create: async (name) => void alarms.push(name),
      exists: async (name) => alarms.includes(name),
    };
    const scheduler = createCleanupScheduler({
      session: sessionStore,
      alarms: alarmsPort,
      loadSettings: async () => ({ ...DEFAULT_SETTINGS, lists: [], ...settings }),
      runCleanup: async (trigger) => void runs.push(trigger),
      logger: quiet,
    });
    return { scheduler, session, alarms, runs };
  }

  it("runs immediately with no delay and collapses concurrent triggers into one run", async () => {
    const { scheduler, runs } = setup({ delaySeconds: 0 });
    await Promise.all([scheduler.schedule("tab-close"), scheduler.schedule("tab-close")]);
    expect(runs).toEqual(["tab-close"]);
  });

  it("uses a worker timer under 30 s and remembers the trigger in session storage", async () => {
    const { scheduler, session, runs } = setup({ delaySeconds: 5 });
    await scheduler.schedule("domain-change");
    expect(session.get(PENDING_TRIGGER_KEY)).toBe("domain-change");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs).toEqual(["domain-change"]);
    expect(session.has(PENDING_TRIGGER_KEY)).toBe(false);
  });

  it("uses an alarm from 30 s and resumes a pending short-delay cleanup after a restart", async () => {
    const long = setup({ delaySeconds: ALARM_MIN_SECONDS });
    await long.scheduler.schedule("tab-close");
    expect(long.alarms).toEqual([CLEANUP_ALARM]);

    const short = setup({ delaySeconds: 5 });
    short.session.set(PENDING_TRIGGER_KEY, "startup");
    await short.scheduler.resumePending();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(short.runs).toEqual(["startup"]);
  });

  it("does nothing while paused", async () => {
    const { scheduler, runs, session } = setup({ delaySeconds: 0, enabled: false });
    await scheduler.schedule("tab-close");
    expect(runs).toEqual([]);
    expect(session.size).toBe(0);
  });
});

describe("store registry", () => {
  it("remembers stores the browser stops listing and forgets them on demand", async () => {
    let known: string[] = ["firefox-container-1"];
    const registry = createStoreRegistry({
      listLiveStores: async () => [{ id: "firefox-default", tabIds: [1] }],
      known: {
        get: async () => known,
        set: async (ids) => void (known = ids),
        update: async (fn) => (known = fn(known)),
      },
    });
    const resolved = await registry.resolve();
    expect(resolved.stores.map((s) => s.id)).toEqual(["firefox-container-1", "firefox-default"]);
    expect(resolved.remembered).toEqual(new Set(["firefox-container-1"]));
    expect(known).toEqual(["firefox-container-1", "firefox-default"]);
    await registry.forget("firefox-container-1");
    expect(known).toEqual(["firefox-default"]);
  });
});

describe("message handler", () => {
  const handle = createMessageHandler({
    cleanSite: async (host) => ({ cookiesRemoved: 1, siteDataDomains: 0, domains: [host] }),
    cleanAll: async () => null,
    refreshBadge: async () => undefined,
  });

  it("rejects clean-site for pages that cannot have cookies", async () => {
    expect(await handle({ type: "clean-site", host: "chrome://settings" })).toEqual({
      ok: false,
      error: "This page cannot have cookies.",
    });
    expect(await handle({ type: "clean-site", host: "https://a.example/" })).toMatchObject({
      ok: true,
      summary: { domains: ["a.example"] },
    });
  });

  it("reports an empty summary when a paused clean-all is skipped", async () => {
    expect(await handle({ type: "clean-all" })).toEqual({
      ok: true,
      summary: { cookiesRemoved: 0, siteDataDomains: 0, domains: [] },
    });
  });
});

// The shared logger is what production passes in; make sure it satisfies the port.
const _logger: Logger = createLogger("test");

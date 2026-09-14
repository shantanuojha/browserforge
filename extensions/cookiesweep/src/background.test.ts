import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { CookiesGetAllDetails, CookiesRemoveDetails, ExecutorCookie } from "./lib/executor.js";
import type { CookieStoreInfo } from "./lib/extension-api.js";
import {
  ACTIVITY_STORAGE_KEY,
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  type ActivityEntry,
  type Settings,
} from "./lib/settings.js";

/**
 * Drives the real background entrypoint against `@webext-core/fake-browser` plus hand-rolled
 * stubs for the APIs the fake does not implement (cookies, browsingData, contextMenus).
 *
 * Tabs are kept in a local list and `tabs.query` / `tabs.get` are stubbed, because the fake's
 * `tabs.remove` looks the window up by the *tab* id and throws before firing `onRemoved`.
 *
 * "Service-worker restart" = drop every listener the previous module instance registered
 * (they die with the worker) and re-import the module, while keeping `storage.session`,
 * alarms and the cookie jar (they survive in the browser).
 */

interface FakeTab {
  id: number;
  url?: string;
  pendingUrl?: string;
  active?: boolean;
}

interface Event {
  removeAllListeners(): void;
  trigger(...args: unknown[]): Promise<unknown[]>;
}

const realSetImmediate = globalThis.setImmediate;
/** Let every pending promise chain settle (a macrotask boundary drains the microtask queue). */
async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => realSetImmediate(r));
}

function cookie(
  partial: Partial<ExecutorCookie> & { name: string; domain: string },
): ExecutorCookie {
  return { path: "/", secure: false, storeId: "0", ...partial };
}

function tabRecord(tab: FakeTab) {
  return {
    id: tab.id,
    index: 0,
    windowId: 0,
    highlighted: false,
    incognito: false,
    pinned: false,
    active: tab.active ?? false,
    ...(tab.url !== undefined ? { url: tab.url } : {}),
    ...(tab.pendingUrl !== undefined ? { pendingUrl: tab.pendingUrl } : {}),
  };
}

let tabs: FakeTab[] = [];
let jar: ExecutorCookie[] = [];
let stores: () => CookieStoreInfo[] = () => [{ id: "0", tabIds: tabs.map((t) => t.id) }];
let removeCalls: CookiesRemoveDetails[] = [];
let getAllFailsFor = new Set<string>();

const cookiesOnChanged = fakeBrowser.webNavigation.onCompleted as unknown as Event; // spare event
const menusOnClicked = fakeBrowser.webNavigation.onDOMContentLoaded as unknown as Event; // spare

function installStubs(): void {
  const b = fakeBrowser as unknown as Record<string, unknown>;
  b.cookies = {
    async getAll(details: CookiesGetAllDetails) {
      if (details.storeId && getAllFailsFor.has(details.storeId)) {
        throw new Error(`Invalid cookie store id: ${details.storeId}`);
      }
      return jar.filter((c) => {
        if (details.storeId && c.storeId !== details.storeId) return false;
        if (details.domain) {
          const d = c.domain.replace(/^\./, "");
          if (d !== details.domain && !d.endsWith(`.${details.domain}`)) return false;
        }
        if (details.partitionKey) return true;
        return c.partitionKey === undefined;
      });
    },
    async remove(details: CookiesRemoveDetails) {
      removeCalls.push(details);
      const host = new URL(details.url).hostname;
      const idx = jar.findIndex(
        (c) =>
          c.name === details.name &&
          c.domain.replace(/^\./, "") === host &&
          c.storeId === (details.storeId ?? "0"),
      );
      // Like Chrome: a missing cookie is not an error, the details are echoed back anyway.
      if (idx >= 0) jar.splice(idx, 1);
      return details;
    },
    async getAllCookieStores() {
      return stores();
    },
    onChanged: cookiesOnChanged,
  };
  b.browsingData = { remove: vi.fn(async () => undefined) };
  b.contextMenus = {
    create: vi.fn((props: { id: string }, cb?: () => void) => {
      cb?.();
      return props.id;
    }),
    removeAll: vi.fn(async () => undefined),
    onClicked: menusOnClicked,
  };
  fakeBrowser.runtime.getManifest = (() => ({ manifest_version: 3 })) as never;
  fakeBrowser.tabs.query = (async (query: { active?: boolean }) =>
    tabs
      .filter((t) => query.active === undefined || (t.active ?? false) === query.active)
      .map(tabRecord)) as never;
  fakeBrowser.tabs.get = (async (id: number) => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) throw new Error(`No tab with id: ${id}.`);
    return tabRecord(tab);
  }) as never;
}

function allEvents(): Event[] {
  const fb = fakeBrowser as unknown as {
    runtime: Record<string, Event>;
    tabs: Record<string, Event>;
    alarms: Record<string, Event>;
    windows: Record<string, Event>;
    storage: Record<string, Event>;
    webNavigation: Record<string, Event>;
  };
  return [
    fb.runtime.onInstalled!,
    fb.runtime.onStartup!,
    fb.runtime.onMessage!,
    fb.tabs.onRemoved!,
    fb.tabs.onActivated!,
    fb.tabs.onUpdated!,
    fb.alarms.onAlarm!,
    fb.windows.onFocusChanged!,
    fb.storage.onChanged!,
    fb.webNavigation.onCommitted!,
    cookiesOnChanged,
    menusOnClicked,
  ];
}

/** Kill the worker: listeners, timers and module state die; browser-side state survives. */
function killWorker(): void {
  for (const event of allEvents()) event.removeAllListeners();
  vi.clearAllTimers();
}

async function startWorker(): Promise<void> {
  vi.resetModules();
  const mod = await import("./entrypoints/background.js");
  (mod.default as { main: () => void }).main();
  await flush();
}

async function seedSettings(partial: Partial<Settings>): Promise<void> {
  await fakeBrowser.storage.local.set({
    [SETTINGS_STORAGE_KEY]: { ...DEFAULT_SETTINGS, lists: [], ...partial },
  });
}

async function activityLog(): Promise<ActivityEntry[]> {
  const stored = await fakeBrowser.storage.local.get(ACTIVITY_STORAGE_KEY);
  return (stored[ACTIVITY_STORAGE_KEY] as ActivityEntry[] | undefined) ?? [];
}

async function closeTab(id: number): Promise<void> {
  tabs = tabs.filter((t) => t.id !== id);
  await (fakeBrowser.tabs.onRemoved as unknown as Event).trigger(id, {
    isWindowClosing: false,
    windowId: 0,
  });
  await flush();
}

async function commitNavigation(tabId: number, url: string): Promise<void> {
  const tab = tabs.find((t) => t.id === tabId);
  if (tab) {
    tab.url = url;
    delete tab.pendingUrl;
  }
  await (fakeBrowser.webNavigation.onCommitted as unknown as Event).trigger({
    tabId,
    frameId: 0,
    url,
    timeStamp: Date.now(),
    transitionType: "link",
    transitionQualifiers: [],
  });
  await flush();
}

const jarNames = () => jar.map((c) => `${c.storeId}:${c.name}`).sort();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  fakeBrowser.reset();
  tabs = [];
  jar = [];
  removeCalls = [];
  getAllFailsFor = new Set();
  stores = () => [{ id: "0", tabIds: tabs.map((t) => t.id) }];
  installStubs();
});

afterEach(() => {
  killWorker();
  vi.useRealTimers();
});

describe("background: tab close", () => {
  beforeEach(async () => {
    tabs = [
      { id: 1, url: "https://mail.example.com/inbox", active: true },
      { id: 2, url: "https://news.site/" },
    ];
    jar = [
      cookie({ name: "sid", domain: ".example.com", secure: true }),
      cookie({ name: "pref", domain: "mail.example.com" }),
      cookie({ name: "news", domain: ".news.site" }),
      cookie({ name: "white", domain: ".keep.me" }),
      cookie({ name: "tracker", domain: ".ads.net" }),
    ];
  });

  it("cleans the closed site and unlisted leftovers, keeps open and whitelisted sites", async () => {
    await seedSettings({
      delaySeconds: 0,
      lists: [{ pattern: "*keep.me", listType: "white" }],
    });
    await startWorker();
    await closeTab(2);
    expect(jarNames()).toEqual(["0:pref", "0:sid", "0:white"]);
    const log = await activityLog();
    expect(log).toHaveLength(1);
    expect(log[0]?.trigger).toBe("tab-close");
    expect(log[0]?.domains).toEqual(["ads.net", "news.site"]);
    expect(log[0]?.cookiesRemoved).toBe(2);
  });

  it("cleans a site when its only tab navigates away, but not on same-site navigation", async () => {
    await seedSettings({ delaySeconds: 0 });
    await startWorker();
    await commitNavigation(2, "https://news.site/other-article");
    expect(jarNames()).toContain("0:news");
    await commitNavigation(2, "https://elsewhere.example/");
    expect(jarNames()).toEqual(["0:pref", "0:sid"]);
    expect((await activityLog())[0]?.trigger).toBe("domain-change");
  });

  it("does not need the closed tab's URL: it re-derives open sites from the remaining tabs", async () => {
    await seedSettings({ delaySeconds: 0 });
    await startWorker();
    // A tab whose URL was never observable to the worker (opened while it was dead).
    tabs.push({ id: 3 });
    await closeTab(3);
    expect(jarNames()).toEqual(["0:news", "0:pref", "0:sid"]);
  });

  it("protects the site a tab is navigating to (pendingUrl), not only the one it is leaving", async () => {
    // Tab 1 has committed example.com but is mid-navigation to shop.other; if a cleanup runs in
    // that window (another tab just closed), the destination's cookies must survive or the user
    // arrives logged out.
    tabs[0]!.pendingUrl = "https://shop.other/checkout";
    jar.push(cookie({ name: "cart", domain: ".shop.other" }));
    await seedSettings({ delaySeconds: 0 });
    await startWorker();
    await closeTab(2);
    expect(jarNames()).toContain("0:cart");
    expect(jarNames()).not.toContain("0:news");
  });

  it("runs one cleanup for a burst of tab closes instead of racing several", async () => {
    // Window close with several tabs of the same site and delaySeconds 0: every onRemoved used
    // to start its own runCleanup(), all of which listed and "removed" the same cookies (Chrome
    // echoes the details for a cookie that is already gone), inflating the activity log.
    tabs = [
      { id: 1, url: "https://a.example.com/" },
      { id: 2, url: "https://b.example.com/" },
      { id: 3, url: "https://c.example.com/" },
    ];
    jar = [
      cookie({ name: "sid", domain: ".example.com" }),
      cookie({ name: "other", domain: ".other.net" }),
    ];
    await seedSettings({ delaySeconds: 0 });
    await startWorker();
    const removed = fakeBrowser.tabs.onRemoved as unknown as Event;
    tabs = [];
    await Promise.all(
      [1, 2, 3].map((id) => removed.trigger(id, { isWindowClosing: true, windowId: 0 })),
    );
    await flush(20);
    expect(jarNames()).toEqual([]);
    // One remove per cookie, not one per concurrent run.
    expect(removeCalls).toHaveLength(2);
    const log = await activityLog();
    expect(log).toHaveLength(1);
    expect(log[0]?.cookiesRemoved).toBe(2);
  });
});

describe("background: cookie stores", () => {
  it("keeps cleaning a container whose last tab closed even though the browser no longer lists it", async () => {
    // Firefox derives getAllCookieStores() from open tabs (ext-cookies.js), so a container
    // disappears from the list the moment its last tab closes, exactly when we need to clean it.
    tabs = [
      { id: 1, url: "https://always.open/" },
      { id: 2, url: "https://work.example/" },
      { id: 3, url: "https://throwaway.example/" },
    ];
    jar = [
      cookie({ name: "d", domain: ".always.open", storeId: "firefox-default" }),
      cookie({ name: "work", domain: ".work.example", storeId: "firefox-container-1" }),
    ];
    stores = () => {
      const out: CookieStoreInfo[] = [{ id: "firefox-default", tabIds: [] }];
      for (const t of tabs) {
        if (t.id === 2) out.push({ id: "firefox-container-1", tabIds: [2] });
        else out[0]!.tabIds.push(t.id);
      }
      return out;
    };
    await seedSettings({ delaySeconds: 0 });
    await startWorker();
    // A first cleanup while the container tab is open: the worker learns the store exists.
    await closeTab(3);
    expect(jarNames()).toEqual(["firefox-container-1:work", "firefox-default:d"]);
    await closeTab(2);
    expect(stores().map((s) => s.id)).toEqual(["firefox-default"]);
    expect(jarNames()).toEqual(["firefox-default:d"]);
    expect((await activityLog())[0]?.storeId).toBe("firefox-container-1");
  });

  it("forgets a remembered store once the browser rejects it (Chrome incognito closed)", async () => {
    tabs = [
      { id: 1, url: "https://always.open/" },
      { id: 2, url: "https://one.example/" },
      { id: 3, url: "https://two.example/" },
      { id: 4, url: "https://three.example/" },
    ];
    jar = [cookie({ name: "d", domain: ".always.open" })];
    let incognitoOpen = true;
    stores = () =>
      incognitoOpen
        ? [
            { id: "0", tabIds: tabs.map((t) => t.id) },
            { id: "1", tabIds: [] },
          ]
        : [{ id: "0", tabIds: tabs.map((t) => t.id) }];
    await seedSettings({ delaySeconds: 0 });
    await startWorker();
    await closeTab(2);
    incognitoOpen = false;
    getAllFailsFor.add("1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await closeTab(3);
    await closeTab(4);
    // Rejected once, then pruned: no second warning for the same dead store.
    expect(warn.mock.calls.filter((c) => String(c[1]).includes("failed for store"))).toHaveLength(
      1,
    );
    warn.mockRestore();
    expect(jarNames()).toEqual(["0:d"]);
  });
});

describe("background: delays and worker restarts", () => {
  beforeEach(async () => {
    tabs = [
      { id: 1, url: "https://stay.example/", active: true },
      { id: 2, url: "https://gone.example/" },
    ];
    jar = [
      cookie({ name: "stay", domain: ".stay.example" }),
      cookie({ name: "gone", domain: ".gone.example" }),
    ];
  });

  it("waits delaySeconds before cleaning and coalesces triggers inside the window", async () => {
    await seedSettings({ delaySeconds: 15 });
    await startWorker();
    await closeTab(2);
    expect(jarNames()).toEqual(["0:gone", "0:stay"]);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(jarNames()).toEqual(["0:gone", "0:stay"]);
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(jarNames()).toEqual(["0:stay"]);
  });

  it("uses an alarm for delays of 30 s or more and survives a worker restart", async () => {
    await seedSettings({ delaySeconds: 60 });
    await startWorker();
    await closeTab(2);
    const alarm = await fakeBrowser.alarms.get("cookiesweep:cleanup");
    expect(alarm).toBeDefined();
    killWorker();
    await startWorker();
    await (fakeBrowser.alarms.onAlarm as unknown as Event).trigger({ name: "cookiesweep:cleanup" });
    await flush();
    expect(jarNames()).toEqual(["0:stay"]);
    expect((await activityLog())[0]?.trigger).toBe("tab-close");
  });

  it("resumes a short-delay cleanup that was pending when the worker died", async () => {
    // Delays under 30 s use setTimeout, which dies with the worker; the pending trigger is
    // in storage.session, so a fresh worker can pick it up instead of leaving the site's
    // cookies behind until the next tab event.
    await seedSettings({ delaySeconds: 15 });
    await startWorker();
    await closeTab(2);
    killWorker();
    await startWorker();
    await vi.advanceTimersByTimeAsync(15_000);
    await flush();
    expect(jarNames()).toEqual(["0:stay"]);
  });

  it("does not run automatic cleanups while paused", async () => {
    await seedSettings({ delaySeconds: 0, enabled: false });
    await startWorker();
    await closeTab(2);
    expect(jarNames()).toEqual(["0:gone", "0:stay"]);
  });
});

describe("background: startup", () => {
  it("expires the greylist but keeps unlisted and restored-tab domains in grey-only scope", async () => {
    tabs = [{ id: 1, url: "https://restored.example/", active: true }];
    jar = [
      cookie({ name: "restored", domain: ".restored.example" }),
      cookie({ name: "grey", domain: ".grey.example" }),
      cookie({ name: "greyopen", domain: ".greyopen.example" }),
      cookie({ name: "unlisted", domain: ".unlisted.example" }),
    ];
    tabs.push({ id: 2, url: "https://greyopen.example/" });
    await seedSettings({
      delaySeconds: 0,
      cleanOnStartup: false,
      lists: [
        { pattern: "*grey.example", listType: "grey" },
        { pattern: "*greyopen.example", listType: "grey" },
      ],
    });
    await startWorker();
    await (fakeBrowser.runtime.onStartup as unknown as Event).trigger();
    await flush();
    expect(jarNames()).toEqual(["0:greyopen", "0:restored", "0:unlisted"]);
    expect((await activityLog())[0]?.trigger).toBe("startup");
  });
});

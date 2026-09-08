/**
 * The real `TabsPort` + event wiring against `@webext-core/fake-browser` (what `wxt/browser`
 * resolves to under WxtVitest). Regression for "the tree is empty after install": windows and
 * tabs that already exist when the background starts must be mirrored by the first rebuild, and
 * later starts (service-worker or browser restart) must re-attach instead of duplicating.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { childrenOf, findByLiveTabId, findWindowByLiveId, type Tree } from "../model";
import { MemoryLogBackend, MemoryTreeStore } from "../store/memory";
import { bindTrackerEvents, browserTabsPort } from "./browser-port";
import { TabTracker } from "./tracker";

type Listener = (...args: unknown[]) => void;

/** fake-browser leaves these tab events unmocked; the tracker only needs to register listeners. */
function stubEvent() {
  const listeners = new Set<Listener>();
  return {
    addListener: (l: Listener) => void listeners.add(l),
    removeListener: (l: Listener) => void listeners.delete(l),
    hasListener: (l: Listener) => listeners.has(l),
    hasListeners: () => listeners.size > 0,
  };
}

const URLS_W1 = ["https://a.example/", "https://b.example/", "https://c.example/"];
const URLS_W2 = ["https://d.example/", "https://e.example/", "https://f.example/"];

async function createWindow(focused: boolean): Promise<number> {
  const win = await fakeBrowser.windows.create({ focused });
  if (win?.id === undefined) throw new Error("fake window without id");
  return win.id;
}

/** Two normal windows with three tabs each, created before any tracker exists. */
async function seedBrowser() {
  const w1Id = await createWindow(true);
  const w2Id = await createWindow(false);
  for (const url of URLS_W1) await fakeBrowser.tabs.create({ windowId: w1Id, url });
  for (const url of URLS_W2) await fakeBrowser.tabs.create({ windowId: w2Id, url });
  return { w1Id, w2Id };
}

/** Mirrors `background.ts`: rebuild on start, listeners registered synchronously and gated. */
async function startBackground(backend = new MemoryLogBackend()) {
  const store = new MemoryTreeStore(backend);
  await store.open();
  const tracker = new TabTracker(store, browserTabsPort);
  const ready = tracker.rebuild();
  const unbind = bindTrackerEvents(tracker, ready);
  const report = await ready;
  return { store, tracker, report, backend, unbind };
}

function liveUrlsUnder(tree: Tree, windowId: number): string[] {
  const win = findWindowByLiveId(tree, windowId);
  if (!win) return [];
  return childrenOf(tree, win.id)
    .filter((n) => n.kind === "tab" && n.liveTabId !== undefined)
    .map((n) => n.url ?? "");
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  fakeBrowser.reset();
  const tabs = fakeBrowser.tabs as unknown as Record<string, unknown>;
  tabs.onMoved = stubEvent();
  tabs.onAttached = stubEvent();
  tabs.onDetached = stubEvent();
  tabs.onReplaced = stubEvent();
});

describe("browserTabsPort + TabTracker on a browser that already has windows", () => {
  it("mirrors every pre-existing window and tab on the first start", async () => {
    const { w1Id, w2Id } = await seedBrowser();
    const { store, report, unbind } = await startBackground();
    const tree = store.getTree();

    expect(report.windowsCreated).toBeGreaterThanOrEqual(2);
    expect(liveUrlsUnder(tree, w1Id)).toEqual(URLS_W1);
    expect(liveUrlsUnder(tree, w2Id)).toEqual(URLS_W2);
    const liveTabs = [...tree.values()].filter((n) => n.kind === "tab" && n.liveTabId !== undefined);
    // 6 seeded tabs; fake-browser's default window contributes one blank tab.
    expect(liveTabs.length).toBeGreaterThanOrEqual(6);
    for (const url of [...URLS_W1, ...URLS_W2]) {
      const t = (await fakeBrowser.tabs.query({ url }))[0];
      expect(t, url).toBeDefined();
      expect(findByLiveTabId(tree, t!.id as number)?.url).toBe(url);
    }
    unbind();
  });

  it("keeps following the browser after start: new tab appears, closed tab becomes saved", async () => {
    const { w1Id } = await seedBrowser();
    const { store, unbind } = await startBackground();

    const created = await fakeBrowser.tabs.create({ windowId: w1Id, url: "https://g.example/" });
    await tick();
    expect(liveUrlsUnder(store.getTree(), w1Id)).toContain("https://g.example/");

    // fake-browser 2.0.1's `tabs.remove` looks the window up by the tab id and throws; fire the
    // event the way the browser would instead.
    await fakeBrowser.tabs.onRemoved.trigger(created.id as number, {
      isWindowClosing: false,
      windowId: w1Id,
    });
    await tick();
    const saved = [...store.getTree().values()].find((n) => n.url === "https://g.example/");
    expect(saved).toBeDefined();
    expect(saved?.liveTabId).toBeUndefined();
    unbind();
  });

  it("re-attaches to the same windows when the service worker restarts (same ids)", async () => {
    const { w1Id, w2Id } = await seedBrowser();
    const first = await startBackground();
    const nodeCount = first.store.getTree().size;
    first.unbind();
    await first.store.close();

    // Same browser session, same persisted log, fresh worker: nothing should be duplicated.
    const second = await startBackground(first.backend);
    expect(second.report.windowsMatched).toBe(first.report.windowsCreated);
    expect(second.report.tabsCreated).toBe(0);
    expect(second.report.nodesSaved).toBe(0);
    expect(second.store.getTree().size).toBe(nodeCount);
    expect(liveUrlsUnder(second.store.getTree(), w1Id)).toEqual(URLS_W1);
    expect(liveUrlsUnder(second.store.getTree(), w2Id)).toEqual(URLS_W2);
    second.unbind();
  });

  it("re-attaches by URL after a browser restart hands out new window and tab ids", async () => {
    await seedBrowser();
    const first = await startBackground();
    const nodeCount = first.store.getTree().size;
    first.unbind();
    await first.store.close();

    // Browser restart: session restore recreates the same pages under new ids.
    fakeBrowser.reset();
    const tabs = fakeBrowser.tabs as unknown as Record<string, unknown>;
    tabs.onMoved = stubEvent();
    tabs.onAttached = stubEvent();
    tabs.onDetached = stubEvent();
    tabs.onReplaced = stubEvent();
    // Burn some ids so they differ from the first session.
    await fakeBrowser.windows.remove(await createWindow(false));
    const { w1Id, w2Id } = await seedBrowser();

    const second = await startBackground(first.backend);
    expect(second.report.tabsMatched).toBeGreaterThanOrEqual(6);
    expect(second.store.getTree().size).toBe(nodeCount);
    expect(liveUrlsUnder(second.store.getTree(), w1Id)).toEqual(URLS_W1);
    expect(liveUrlsUnder(second.store.getTree(), w2Id)).toEqual(URLS_W2);
    second.unbind();
  });
});

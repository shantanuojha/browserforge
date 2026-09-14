/**
 * Drives the real background entrypoint against WXT's fake browser. The
 * pieces fake-browser does not implement (declarativeNetRequest, contextMenus)
 * are replaced with small in-memory stubs so the whole rebuild / fallback /
 * sync orchestration can be exercised without Chrome.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type * as LicensingAdapter from "./adapters/licensing";
import { allowlistItem, logItem, rulesItem, settingsItem } from "./adapters/storage";
import { browserSyncArea } from "./adapters/sync-area";
import background from "./entrypoints/background";
import type { DnrRule } from "./lib/dnr";
import type { StatusResponse } from "./lib/messages";
import { createRule, type Rule } from "./lib/rules/model";
import { createSyncStore } from "./lib/sync/store";

const proState = vi.hoisted(() => ({ pro: false }));
vi.mock("./adapters/licensing", async (importOriginal) => ({
  ...(await importOriginal<typeof LicensingAdapter>()),
  isPro: async () => proState.pro,
}));

/** The same sync storage the background writes to, seen through the store API. */
const sync = createSyncStore(browserSyncArea);
const writeRulesToSync = (rules: Rule[], origin: string) => sync.write(rules, origin);
const readRulesFromSync = () => sync.read();

interface DnrStub {
  rules: DnrRule[];
  enabledRulesets: string[];
  getDynamicRules(): Promise<DnrRule[]>;
  updateDynamicRules(opts: { removeRuleIds?: number[]; addRules?: DnrRule[] }): Promise<void>;
  getEnabledRulesets(): Promise<string[]>;
  updateEnabledRulesets(opts: {
    enableRulesetIds?: string[];
    disableRulesetIds?: string[];
  }): Promise<void>;
  isRegexSupported(): Promise<{ isSupported: boolean }>;
}

function installStubs(): DnrStub {
  const dnr: DnrStub = {
    rules: [],
    enabledRulesets: ["tracking-params"],
    async getDynamicRules() {
      return [...this.rules];
    },
    async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
      const remove = new Set(removeRuleIds);
      this.rules = [...this.rules.filter((r) => !remove.has(r.id)), ...addRules];
    },
    async getEnabledRulesets() {
      return [...this.enabledRulesets];
    },
    async updateEnabledRulesets({ enableRulesetIds = [], disableRulesetIds = [] }) {
      const off = new Set(disableRulesetIds);
      this.enabledRulesets = [
        ...this.enabledRulesets.filter((id) => !off.has(id)),
        ...enableRulesetIds,
      ];
    },
    async isRegexSupported() {
      return { isSupported: true };
    },
  };
  Object.assign(fakeBrowser as unknown as Record<string, unknown>, {
    declarativeNetRequest: dnr,
    contextMenus: {
      removeAll: async () => undefined,
      create: () => "menu",
      onClicked: { addListener: () => undefined },
    },
  });
  return dnr;
}

function getStatus(): Promise<StatusResponse> {
  return new Promise((resolve) => {
    void fakeBrowser.runtime.onMessage.trigger({ type: "reroute:get-status" }, {}, resolve);
  });
}

async function navigate(tabId: number, url: string): Promise<void> {
  await fakeBrowser.webNavigation.onBeforeNavigate.trigger({
    tabId,
    frameId: 0,
    parentFrameId: -1,
    processId: 0,
    timeStamp: Date.now(),
    url,
    documentLifecycle: "active",
    frameType: "outermost_frame",
  } satisfies Browser.webNavigation.WebNavigationBaseCallbackDetails);
}

const jsOnlyRule = (): Rule =>
  createRule({
    id: "js",
    name: "JS only (has exclude)",
    include: "https://a.example/*",
    exclude: ["https://a.example/keep/*"],
    redirectTo: "https://b.example/$1",
  });

const dnrRule = (): Rule =>
  createRule({ id: "dnr", include: "https://c.example/*", redirectTo: "https://d.example/$1" });

describe("background", () => {
  let dnr: DnrStub;

  beforeEach(() => {
    fakeBrowser.reset();
    fakeBrowser.webNavigation.onBeforeNavigate.removeAllListeners();
    fakeBrowser.webNavigation.onHistoryStateUpdated.removeAllListeners();
    dnr = installStubs();
    proState.pro = false;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("compiles stored rules to dynamic DNR rules and serves JS-only ones via tabs.update", async () => {
    await rulesItem.setValue([jsOnlyRule(), dnrRule()]);
    background.main();
    const status = await getStatus();
    expect(status.enabledRules).toBe(2);
    expect(status.jsOnlyRuleIds).toEqual(["js"]);
    expect(dnr.rules.map((r) => r.action.type)).toEqual(["redirect"]);

    const tab = await fakeBrowser.tabs.create({ url: "https://a.example/x" });
    await navigate(tab.id!, "https://a.example/x");
    await vi.waitFor(async () => {
      expect((await fakeBrowser.tabs.get(tab.id!))?.url).toBe("https://b.example/x");
      expect((await logItem.getValue()).map((e) => e.kind)).toEqual(["js"]);
    });
  });

  it("status.dnrRules counts user rules only, not the allowlist allow rules", async () => {
    await rulesItem.setValue([dnrRule()]);
    await allowlistItem.setValue(["x.example"]);
    background.main();
    const status = await getStatus();
    expect(dnr.rules.some((r) => r.action.type === "allow")).toBe(true);
    expect(status.dnrRules).toBe(1);
  });

  it("clearing the activity log from the options page is not undone by the next event", async () => {
    await rulesItem.setValue([jsOnlyRule()]);
    background.main();
    await getStatus();
    const tab = await fakeBrowser.tabs.create({ url: "https://a.example/1" });

    await navigate(tab.id!, "https://a.example/1");
    await vi.waitFor(async () => expect(await logItem.getValue()).toHaveLength(1));

    // Options page: "Clear log".
    await logItem.setValue([]);

    await navigate(tab.id!, "https://a.example/2");
    await vi.waitFor(async () => {
      const log = await logItem.getValue();
      expect(log.map((e) => e.to)).toEqual(["https://b.example/2"]);
    });
  });

  it("enabling sync on a device with no rules adopts the remote set instead of wiping it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    proState.pro = true;
    const remote = [
      createRule({
        id: "r1",
        include: "https://one.example/*",
        redirectTo: "https://1.example/$1",
      }),
      createRule({
        id: "r2",
        include: "https://two.example/*",
        redirectTo: "https://2.example/$1",
      }),
    ];
    await writeRulesToSync(remote, "other-device");

    background.main();
    await getStatus();
    expect(await rulesItem.getValue()).toEqual([]);

    await settingsItem.setValue({ trackingEnabled: true, syncEnabled: true });
    await vi.advanceTimersByTimeAsync(5_000);
    // This device adopts the remote rules...
    await vi.waitFor(async () => expect(await rulesItem.getValue()).toEqual(remote));
    await vi.advanceTimersByTimeAsync(5_000);
    // ...and the other device's rules survive in sync.
    expect((await readRulesFromSync())?.rules).toEqual(remote);
  });

  it("enabling sync on a device that already has rules merges both sets", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    proState.pro = true;
    const remote = [
      createRule({
        id: "r1",
        include: "https://one.example/*",
        redirectTo: "https://1.example/$1",
      }),
    ];
    const local = [
      createRule({
        id: "l1",
        include: "https://loc.example/*",
        redirectTo: "https://l.example/$1",
      }),
    ];
    await writeRulesToSync(remote, "other-device");
    await rulesItem.setValue(local);

    background.main();
    await getStatus();
    await settingsItem.setValue({ trackingEnabled: true, syncEnabled: true });
    await vi.waitFor(async () => expect(await rulesItem.getValue()).toEqual([...remote, ...local]));
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(async () =>
      expect((await readRulesFromSync())?.rules).toEqual([...remote, ...local]),
    );
  });

  it("applies remote sync changes and does not echo them back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    proState.pro = true;
    await settingsItem.setValue({ trackingEnabled: true, syncEnabled: true });
    background.main();
    await getStatus();

    const remote = [
      createRule({
        id: "r1",
        include: "https://one.example/*",
        redirectTo: "https://1.example/$1",
      }),
    ];
    const meta = await writeRulesToSync(remote, "other-device");
    await vi.waitFor(async () => expect(await rulesItem.getValue()).toEqual(remote));
    await vi.advanceTimersByTimeAsync(5_000);
    // Our copy of the snapshot was not re-written under our own origin.
    expect((await readRulesFromSync())?.meta.origin).toBe(meta.origin);
  });
});

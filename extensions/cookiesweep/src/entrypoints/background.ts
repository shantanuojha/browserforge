/**
 * Background entrypoint: wires browser events to the background services. All logic lives in
 * `lib/background`; everything here is registration and adapter plumbing.
 */
import {
  createLogger,
  createMessageListener,
  errorMessage,
  systemClock,
} from "@browserforge/shared";
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { browserAlarms } from "../adapters/alarms.js";
import { browserBadgePainter } from "../adapters/badge-painter.js";
import { onContextMenuClicked, setupContextMenus } from "../adapters/context-menus.js";
import {
  createExecutorApi,
  getCookieStores,
  listOpenTabs,
  resolveBadgeTab,
  storeIdForTab,
} from "../adapters/extension-api.js";
import { createBrowserSessionStore } from "../adapters/session-store.js";
import {
  activityLogKey,
  knownStoresKey,
  loadSettings,
  seedDefaultSettings,
  settingsKey,
  updateSettings,
} from "../adapters/settings-store.js";
import { createBadgeController, type BadgeController } from "../lib/background/badge.js";
import { createCleanupRunner, type CleanupRunner } from "../lib/background/cleanup-runner.js";
import { createMessageHandler } from "../lib/background/message-handler.js";
import {
  CLEANUP_ALARM,
  createCleanupScheduler,
  type CleanupScheduler,
} from "../lib/background/scheduler.js";
import { createStoreRegistry } from "../lib/background/store-registry.js";
import { TabHostTracker } from "../lib/background/tab-hosts.js";
import { countCookiesForHost } from "../lib/executor.js";
import { isMessage, type MessageResponse } from "../lib/messages.js";
import { hostFromTabUrl, suggestedPattern } from "../lib/planner.js";
import { addListEntry, appendActivity, type ActivityEntry } from "../lib/settings.js";

const log = createLogger("cookiesweep");

interface Services {
  badge: BadgeController;
  runner: CleanupRunner;
  scheduler: CleanupScheduler;
  tabHosts: TabHostTracker;
}

function createServices(): Services {
  const api = createExecutorApi();
  const badge = createBadgeController({
    painter: browserBadgePainter,
    resolveTab: resolveBadgeTab,
    storeIdForTab,
    countCookies: (storeId, host) => countCookiesForHost(api, storeId, host),
    loadSettings,
    logger: log,
  });
  const runner = createCleanupRunner({
    api,
    listTabs: listOpenTabs,
    registry: createStoreRegistry({ listLiveStores: getCookieStores, known: knownStoresKey }),
    storeIdForTab,
    loadSettings,
    activity: {
      async append(entries) {
        await activityLogKey.update((current) => {
          const existing: ActivityEntry[] = Array.isArray(current) ? current : [];
          return entries.reduce((next, entry) => appendActivity(next, entry), existing);
        });
      },
    },
    notifier: {
      sweepFinished(summary, settings) {
        if (settings.notifications && summary.cookiesRemoved > 0)
          void badge.flash(summary.cookiesRemoved);
        else void badge.refresh();
      },
      siteCleaned: () => void badge.refresh(),
    },
    clock: systemClock,
    logger: log,
  });
  const scheduler = createCleanupScheduler({
    session: createBrowserSessionStore(),
    alarms: browserAlarms,
    loadSettings,
    runCleanup: (trigger) => runner.runCleanup(trigger),
    logger: log,
  });
  return { badge, runner, scheduler, tabHosts: new TabHostTracker() };
}

async function whitelistHost(host: string): Promise<void> {
  await updateSettings((s) => ({
    ...s,
    lists: addListEntry(s.lists, { pattern: suggestedPattern(host), listType: "white" }),
  }));
}

async function primeTabHosts(tabHosts: TabHostTracker): Promise<void> {
  try {
    tabHosts.prime(await listOpenTabs());
  } catch (error) {
    log.warn("could not list tabs", error);
  }
}

function registerLifecycle({ badge, scheduler, tabHosts }: Services): void {
  browser.runtime.onInstalled.addListener(() => {
    void (async () => {
      await seedDefaultSettings();
      await setupContextMenus();
      await primeTabHosts(tabHosts);
      await badge.refresh();
    })();
  });
  browser.runtime.onStartup.addListener(() => {
    void setupContextMenus();
    void primeTabHosts(tabHosts);
    void scheduler.schedule("startup");
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === CLEANUP_ALARM) void scheduler.runPending();
  });
}

function registerTabEvents({ badge, scheduler, tabHosts }: Services): void {
  browser.tabs.onRemoved.addListener((tabId) => {
    tabHosts.forget(tabId);
    void scheduler.schedule("tab-close");
  });
  browser.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    if (tabHosts.commit(details.tabId, hostFromTabUrl(details.url))) {
      void scheduler.schedule("domain-change");
    }
  });
  browser.tabs.onActivated.addListener(({ tabId }) => void badge.refresh(tabId));
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!tab.active) return;
    if (changeInfo.url !== undefined || changeInfo.status === "complete") void badge.refresh(tabId);
  });
}

function registerBadgeTriggers({ badge }: Services): void {
  if (browser.windows?.onFocusChanged) {
    browser.windows.onFocusChanged.addListener(() => badge.refreshDebounced());
  }
  browser.cookies.onChanged.addListener(() => badge.refreshDebounced());
  settingsKey.watch(() => badge.refreshDebounced());
}

function registerCommands({ badge, runner }: Services): void {
  onContextMenuClicked({
    whitelistSite: (host, tabId) => void whitelistHost(host).then(() => badge.refresh(tabId)),
    cleanSite: (host, tabId) => void runner.cleanSite(host, tabId),
  });
  const handle = createMessageHandler({
    cleanSite: (host, tabId) => runner.cleanSite(host, tabId),
    cleanAll: () => runner.runCleanup("manual", { force: true, greyExpired: true }),
    refreshBadge: () => badge.refresh(),
  });
  browser.runtime.onMessage.addListener(
    createMessageListener({
      accepts: isMessage,
      handle,
      onError: (error): MessageResponse => ({ ok: false, error: errorMessage(error) }),
    }),
  );
}

export default defineBackground(() => {
  const services = createServices();
  registerLifecycle(services);
  registerTabEvents(services);
  registerBadgeTriggers(services);
  registerCommands(services);

  // The worker may have just been revived: make sure the badge and tab memory are warm and
  // that a cleanup the previous worker owed is not lost.
  void primeTabHosts(services.tabHosts);
  void services.badge.refresh();
  void services.scheduler
    .resumePending()
    .catch((error) => log.warn("could not resume cleanup", error));
});

import { defineBackground } from "wxt/utils/define-background";
import { browser, type Browser } from "wxt/browser";
import { createLogger } from "@browserforge/shared";
import {
  cleanDomainsInStore,
  countCookiesForHost,
  executePlan,
  listCookies,
  planningDomains,
  type ExecuteResult,
  type ExecutorCookie,
} from "../lib/executor.js";
import {
  createExecutorApi,
  getActionApi,
  getActiveTab,
  getCookieStores,
  storeIdForTab,
  tabUrl,
} from "../lib/extension-api.js";
import {
  isMessage,
  type CleanupSummary,
  type Message,
  type MessageResponse,
} from "../lib/messages.js";
import {
  classifyHost,
  domainsForSite,
  hostFromTabUrl,
  planCleanup,
  sameSite,
  suggestedPattern,
} from "../lib/planner.js";
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  activityLogKey,
  addListEntry,
  appendActivity,
  createActivityId,
  loadSettings,
  normalizeSettings,
  settingsKey,
  updateSettings,
  type ActivityEntry,
  type CleanupTrigger,
} from "../lib/settings.js";

const log = createLogger("cookiesweep");

const ALARM_NAME = "cookiesweep:cleanup";
const MENU_WHITELIST = "cookiesweep:whitelist-site";
const MENU_CLEAN = "cookiesweep:clean-site";
const PENDING_TRIGGER_KEY = "cookiesweep:pendingTrigger";
/** Production alarms are clamped to 30 s; shorter delays use setTimeout in the worker. */
const ALARM_MIN_SECONDS = 30;
const BADGE_FLASH_MS = 4000;
const BADGE_DEBOUNCE_MS = 400;

const COLOR_DEFAULT = "#3b5bdb";
const COLOR_WHITE = "#2f9e44";
const COLOR_GREY = "#868e96";
const COLOR_PAUSED = "#495057";
const COLOR_FLASH = "#e8590c";

const TRIGGER_PRIORITY: Record<CleanupTrigger, number> = {
  "tab-close": 1,
  "domain-change": 1,
  manual: 2,
  startup: 3,
};

// ---------------------------------------------------------------------------
// Session-scoped state (survives service-worker restarts where storage.session exists)
// ---------------------------------------------------------------------------

const memoryState = new Map<string, unknown>();

function sessionArea(): Browser.storage.StorageArea | undefined {
  const storage = browser.storage as { session?: Browser.storage.StorageArea };
  return storage.session;
}

async function getSessionValue<T>(key: string): Promise<T | undefined> {
  const area = sessionArea();
  if (area) {
    try {
      const result = await area.get(key);
      return result[key] as T | undefined;
    } catch {
      // fall back to memory
    }
  }
  return memoryState.get(key) as T | undefined;
}

async function setSessionValue(key: string, value: unknown): Promise<void> {
  const area = sessionArea();
  if (area) {
    try {
      if (value === undefined) await area.remove(key);
      else await area.set({ [key]: value });
      return;
    } catch {
      // fall back to memory
    }
  }
  if (value === undefined) memoryState.delete(key);
  else memoryState.set(key, value);
}

// ---------------------------------------------------------------------------
// Cleanup runs
// ---------------------------------------------------------------------------

interface RunOptions {
  /** Run even when the extension is paused (explicit user action). */
  force?: boolean;
  /** Treat greylisted domains as expired. Defaults to `trigger === "startup"`. */
  greyExpired?: boolean;
}

function summarize(results: readonly ExecuteResult[]): CleanupSummary {
  const domains = new Set<string>();
  let cookiesRemoved = 0;
  let siteDataDomains = 0;
  for (const r of results) {
    cookiesRemoved += r.cookiesRemoved;
    siteDataDomains += r.siteDataDomains;
    if (r.cookiesRemoved > 0 || r.siteDataDomains > 0) r.domains.forEach((d) => domains.add(d));
  }
  return { cookiesRemoved, siteDataDomains, domains: [...domains].sort() };
}

async function recordResults(trigger: CleanupTrigger, results: readonly ExecuteResult[]) {
  const now = Date.now();
  const entries: ActivityEntry[] = results
    .filter((r) => r.cookiesRemoved > 0 || r.siteDataDomains > 0)
    .map((r) => ({
      id: createActivityId(now),
      at: now,
      trigger,
      storeId: r.storeId,
      domains: r.domains,
      cookiesRemoved: r.cookiesRemoved,
      siteDataDomains: r.siteDataDomains,
    }));
  if (entries.length === 0) return;
  await activityLogKey.update((current) => {
    let next = Array.isArray(current) ? current : [];
    for (const entry of entries) next = appendActivity(next, entry);
    return next;
  });
}

async function runCleanup(
  trigger: CleanupTrigger,
  options: RunOptions = {},
): Promise<CleanupSummary | null> {
  const settings = await loadSettings();
  if (!settings.enabled && !options.force) {
    log.debug("paused; skipping", trigger);
    return null;
  }

  const api = createExecutorApi();
  const stores = await getCookieStores();
  const tabs = await browser.tabs.query({});

  const urlByTab = new Map<number, string>();
  for (const tab of tabs) {
    const url = tabUrl(tab);
    if (tab.id !== undefined && url) urlByTab.set(tab.id, url);
  }

  const assigned = new Set<number>();
  const openTabHosts: Record<string, string[]> = {};
  for (const store of stores) {
    openTabHosts[store.id] = store.tabIds.flatMap((id) => {
      assigned.add(id);
      const url = urlByTab.get(id);
      return url ? [url] : [];
    });
  }
  // Tabs the browser did not attribute to a store: protect them in every store.
  const orphanUrls = [...urlByTab.entries()].filter(([id]) => !assigned.has(id)).map(([, u]) => u);
  if (orphanUrls.length > 0) {
    for (const store of stores) openTabHosts[store.id]?.push(...orphanUrls);
  }

  const cookiesByStore: Record<string, ExecutorCookie[]> = {};
  const cookieDomains: Record<string, string[]> = {};
  for (const store of stores) {
    try {
      const cookies = await listCookies(api, store.id);
      cookiesByStore[store.id] = cookies;
      cookieDomains[store.id] = planningDomains(cookies);
    } catch (error) {
      log.warn("cookies.getAll failed for store", store.id, error);
    }
  }

  const plan = planCleanup({
    openTabHosts,
    cookieDomains,
    lists: settings.lists,
    greyExpiredAtRestart: options.greyExpired ?? trigger === "startup",
    trigger,
    startupScope: settings.cleanOnStartup ? "full" : "grey-only",
  });

  const results = await executePlan(
    api,
    plan,
    { cleanSiteData: settings.cleanSiteData },
    cookiesByStore,
  );
  await recordResults(trigger, results);

  const summary = summarize(results);
  log.info(
    `${trigger}: removed ${summary.cookiesRemoved} cookie(s) from ${summary.domains.length} domain(s)`,
  );
  if (settings.notifications && summary.cookiesRemoved > 0) {
    void flashBadge(summary.cookiesRemoved);
  } else {
    void refreshBadge();
  }
  return summary;
}

/** Explicit "clean this site now": ignores lists and open tabs for that one site. */
async function cleanSite(host: string, tabId?: number): Promise<CleanupSummary> {
  const settings = await loadSettings();
  const api = createExecutorApi();
  const storeId = await storeIdForTab(tabId);
  const cookies = await listCookies(api, storeId);
  const domains = domainsForSite(planningDomains(cookies), host);
  const result = await cleanDomainsInStore(
    api,
    storeId,
    domains,
    { cleanSiteData: settings.cleanSiteData, extraHosts: [host] },
    cookies,
  );
  await recordResults("manual", [result]);
  log.info(`manual: cleaned ${host} (${result.cookiesRemoved} cookie(s))`);
  void refreshBadge();
  return summarize([result]);
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

let shortTimer: ReturnType<typeof setTimeout> | undefined;

async function mergePendingTrigger(trigger: CleanupTrigger): Promise<void> {
  const current = await getSessionValue<CleanupTrigger>(PENDING_TRIGGER_KEY);
  if (!current || TRIGGER_PRIORITY[trigger] > TRIGGER_PRIORITY[current]) {
    await setSessionValue(PENDING_TRIGGER_KEY, trigger);
  }
}

async function runPendingCleanup(): Promise<void> {
  const trigger = (await getSessionValue<CleanupTrigger>(PENDING_TRIGGER_KEY)) ?? "tab-close";
  await setSessionValue(PENDING_TRIGGER_KEY, undefined);
  try {
    await runCleanup(trigger);
  } catch (error) {
    log.error("cleanup failed", error);
  }
}

async function scheduleCleanup(trigger: CleanupTrigger): Promise<void> {
  const settings = await loadSettings();
  if (!settings.enabled) return;
  await mergePendingTrigger(trigger);

  const delay = settings.delaySeconds;
  if (delay <= 0) {
    await runPendingCleanup();
    return;
  }
  if (delay < ALARM_MIN_SECONDS) {
    // Alarms are clamped to 30 s in production builds; use a worker timer and accept
    // that it can be lost if the service worker is suspended first.
    if (shortTimer) clearTimeout(shortTimer);
    shortTimer = setTimeout(() => {
      shortTimer = undefined;
      void runPendingCleanup();
    }, delay * 1000);
    return;
  }
  // Re-creating an alarm with the same name replaces it, so bursts of triggers coalesce.
  await browser.alarms.create(ALARM_NAME, { delayInMinutes: delay / 60 });
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

async function paintBadge(tabId: number, text: string, color: string): Promise<void> {
  const action = getActionApi();
  if (!action) return;
  try {
    await action.setBadgeText({ text, tabId });
    await action.setBadgeBackgroundColor({ color, tabId });
    if (typeof action.setBadgeTextColor === "function") {
      await action.setBadgeTextColor({ color: "#ffffff", tabId });
    }
  } catch {
    // Tab may have been closed in the meantime.
  }
}

async function refreshBadge(tabId?: number): Promise<void> {
  let tab: Browser.tabs.Tab | undefined;
  try {
    tab = tabId !== undefined ? await browser.tabs.get(tabId) : await getActiveTab();
  } catch {
    return;
  }
  if (!tab || tab.id === undefined) return;
  const id = tab.id;
  const host = hostFromTabUrl(tabUrl(tab));
  if (!host) {
    await paintBadge(id, "", COLOR_DEFAULT);
    return;
  }
  const settings = await loadSettings();
  if (!settings.enabled) {
    await paintBadge(id, "off", COLOR_PAUSED);
    return;
  }
  try {
    const storeId = await storeIdForTab(id);
    const count = await countCookiesForHost(createExecutorApi(), storeId, host);
    const status = classifyHost(host, storeId, settings.lists);
    const color = status === "white" ? COLOR_WHITE : status === "grey" ? COLOR_GREY : COLOR_DEFAULT;
    await paintBadge(id, String(count), color);
  } catch (error) {
    log.warn("badge update failed", error);
  }
}

async function flashBadge(removed: number): Promise<void> {
  const tab = await getActiveTab().catch(() => undefined);
  if (!tab || tab.id === undefined) return;
  await paintBadge(tab.id, `-${removed}`, COLOR_FLASH);
  setTimeout(() => void refreshBadge(), BADGE_FLASH_MS);
}

let badgeTimer: ReturnType<typeof setTimeout> | undefined;
function refreshBadgeDebounced(): void {
  if (badgeTimer) clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    badgeTimer = undefined;
    void refreshBadge();
  }, BADGE_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Context menus
// ---------------------------------------------------------------------------

function createMenu(props: Browser.contextMenus.CreateProperties): void {
  try {
    browser.contextMenus.create(props, () => {
      // Read lastError so Chrome does not log "Unchecked runtime.lastError".
      void browser.runtime.lastError;
    });
  } catch (error) {
    log.warn("contextMenus.create failed", error);
  }
}

async function setupContextMenus(): Promise<void> {
  if (!browser.contextMenus) return;
  try {
    await browser.contextMenus.removeAll();
  } catch {
    // ignore
  }
  // The toolbar-icon context is "action" on MV3 and "browser_action" on Firefox MV2.
  const manifestVersion = browser.runtime.getManifest().manifest_version;
  const contexts = ["page", manifestVersion >= 3 ? "action" : "browser_action"] as const;
  createMenu({
    id: MENU_WHITELIST,
    title: "Whitelist this site",
    contexts: [...contexts],
    documentUrlPatterns: ["http://*/*", "https://*/*"],
  });
  createMenu({
    id: MENU_CLEAN,
    title: "Clean this site now",
    contexts: [...contexts],
    documentUrlPatterns: ["http://*/*", "https://*/*"],
  });
}

async function whitelistHost(host: string): Promise<void> {
  await updateSettings((s) => ({
    ...s,
    lists: addListEntry(s.lists, { pattern: suggestedPattern(host), listType: "white" }),
  }));
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

async function handleMessage(message: Message): Promise<MessageResponse> {
  switch (message.type) {
    case "clean-site": {
      const host = hostFromTabUrl(message.host);
      if (!host) return { ok: false, error: "This page cannot have cookies." };
      return { ok: true, summary: await cleanSite(host, message.tabId) };
    }
    case "clean-all": {
      const summary = await runCleanup("manual", { force: true, greyExpired: true });
      return summary
        ? { ok: true, summary }
        : { ok: true, summary: { cookiesRemoved: 0, siteDataDomains: 0, domains: [] } };
    }
    case "refresh-badge": {
      await refreshBadge();
      return { ok: true };
    }
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function seedDefaults(): Promise<void> {
  const stored = await settingsKey.area.get<unknown>(SETTINGS_STORAGE_KEY);
  if (stored === undefined) {
    await settingsKey.set({ ...DEFAULT_SETTINGS, lists: [] });
  } else {
    // Migrate partial/older objects to the full schema.
    await settingsKey.set(normalizeSettings(stored));
  }
}

/** Last known http(s) host per tab, to detect domain changes. */
const tabHosts = new Map<number, string | null>();

async function primeTabHosts(): Promise<void> {
  try {
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      if (tab.id !== undefined && !tabHosts.has(tab.id)) {
        tabHosts.set(tab.id, hostFromTabUrl(tabUrl(tab)));
      }
    }
  } catch {
    // ignore
  }
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    void (async () => {
      await seedDefaults();
      await setupContextMenus();
      await primeTabHosts();
      await refreshBadge();
    })();
  });

  browser.runtime.onStartup.addListener(() => {
    void setupContextMenus();
    void primeTabHosts();
    void scheduleCleanup("startup");
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    tabHosts.delete(tabId);
    void scheduleCleanup("tab-close");
  });

  browser.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    const nextHost = hostFromTabUrl(details.url);
    const hadPrevious = tabHosts.has(details.tabId);
    const previous = tabHosts.get(details.tabId) ?? null;
    tabHosts.set(details.tabId, nextHost);
    const leftSite = previous !== null && (nextHost === null || !sameSite(previous, nextHost));
    if (!hadPrevious || leftSite) {
      void scheduleCleanup("domain-change");
    }
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) void runPendingCleanup();
  });

  browser.tabs.onActivated.addListener(({ tabId }) => {
    void refreshBadge(tabId);
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!tab.active) return;
    if (changeInfo.url !== undefined || changeInfo.status === "complete") {
      void refreshBadge(tabId);
    }
  });

  if (browser.windows?.onFocusChanged) {
    browser.windows.onFocusChanged.addListener(() => refreshBadgeDebounced());
  }

  browser.cookies.onChanged.addListener(() => refreshBadgeDebounced());

  settingsKey.watch(() => refreshBadgeDebounced());

  if (browser.contextMenus) {
    browser.contextMenus.onClicked.addListener((info, tab) => {
      const host = hostFromTabUrl(info.pageUrl ?? tabUrl(tab));
      if (!host) return;
      if (info.menuItemId === MENU_WHITELIST) {
        void whitelistHost(host).then(() => refreshBadge(tab?.id));
      } else if (info.menuItemId === MENU_CLEAN) {
        void cleanSite(host, tab?.id);
      }
    });
  }

  browser.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    if (!isMessage(raw)) return false;
    handleMessage(raw)
      .then((response) => sendResponse(response))
      .catch((error: unknown) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies MessageResponse),
      );
    return true;
  });

  // The worker may have just been revived: make sure the badge and tab memory are warm.
  void primeTabHosts();
  void refreshBadge();
});

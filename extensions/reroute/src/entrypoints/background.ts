/**
 * Background entrypoint: wires browser events to the background service. All logic lives in
 * `lib/background`; everything here is registration and adapter plumbing.
 */
import { createLogger, createMessageListener, systemClock } from "@browserforge/shared";
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { installCopyCleanLinkMenu, onCopyCleanLinkClicked } from "../adapters/context-menu";
import { browserDnr } from "../adapters/dnr";
import { isPro, setupLicensing } from "../adapters/licensing";
import { allowlistItem, logItem, rulesItem, settingsItem } from "../adapters/storage";
import { browserSyncArea, onSyncManifestChanged } from "../adapters/sync-area";
import { browserTabs } from "../adapters/tabs";
import { loadTrackingRules } from "../adapters/tracking-rules";
import { createBackgroundService, type BackgroundService } from "../lib/background/service";
import { isMessage, type Message } from "../lib/messages";
import { createSyncStore } from "../lib/sync/store";
import { newOrigin } from "../lib/sync/codec";

const log = createLogger("reroute:bg");

function registerNavigationListeners(service: BackgroundService): void {
  browser.webNavigation.onBeforeNavigate.addListener((details) => {
    if (details.frameId !== 0) return;
    void service.fallback.handleNavigation(details.tabId, details.url, "navigate");
  });
  browser.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId !== 0) return;
    void service.fallback.handleNavigation(details.tabId, details.url, "history");
  });
  browser.tabs.onRemoved.addListener((tabId) => service.fallback.forgetTab(tabId));
}

function registerStorageWatchers(service: BackgroundService): void {
  rulesItem.watch(() => void service.onRulesChanged());
  allowlistItem.watch(() => void service.onAllowlistChanged());
  settingsItem.watch((next, previous) => void service.onSettingsChanged(next, previous));
  onSyncManifestChanged(() => void service.mirror.applyRemoteChange());
}

function registerLifecycle(service: BackgroundService): void {
  const onStart = () => {
    void installCopyCleanLinkMenu();
    void service.rebuild();
  };
  browser.runtime.onInstalled.addListener(onStart);
  browser.runtime.onStartup.addListener(onStart);
  onCopyCleanLinkClicked((request) => void service.copyCleanLink(request));
}

function registerMessageHandler(service: BackgroundService): void {
  const handle = async (message: Message): Promise<unknown> => {
    switch (message.type) {
      case "reroute:get-status":
        return service.getStatus();
      case "reroute:rebuild":
        await service.rebuild();
        return { ok: true };
      default:
        return undefined;
    }
  };
  browser.runtime.onMessage.addListener(createMessageListener({ accepts: isMessage, handle }));
}

/** `declarativeNetRequestFeedback` diagnostics; the permission only exists in dev builds. */
function registerDevDiagnostics(service: BackgroundService): void {
  const debugEvent = browser.declarativeNetRequest.onRuleMatchedDebug;
  if (debugEvent && typeof debugEvent.addListener === "function") {
    debugEvent.addListener(({ rule, request }) => {
      void service.recorder.record({
        kind: "dnr",
        tabId: request.tabId,
        from: request.url,
        detail: `${rule.rulesetId} #${rule.ruleId}`,
      });
    });
  }
  // Surface static regexes the engine rejects so the catalog compiler can be tuned.
  void service.whenIdle().then(async () => {
    for (const rule of await loadTrackingRules()) {
      if (rule.condition.regexFilter && !(await service.deployer.isRegexSupported(rule))) {
        log.warn("static regex unsupported:", rule.id, rule.condition.regexFilter);
      }
    }
  });
}

export default defineBackground(() => {
  // Keeps the stored licence fresh: a cheap validate() now, a forced one on the periodic alarm.
  // Offline stays Pro for the grace period. Nothing here runs when licensing is not configured.
  setupLicensing()?.scheduleRevalidation(browser.alarms);

  const service = createBackgroundService({
    dnr: browserDnr,
    tabs: browserTabs,
    rulesStore: rulesItem,
    allowlistStore: allowlistItem,
    settingsStore: settingsItem,
    logStore: logItem,
    syncStore: createSyncStore(browserSyncArea, systemClock),
    syncOrigin: newOrigin(),
    isPro,
    loadTrackingRules,
    clock: systemClock,
  });

  registerNavigationListeners(service);
  registerStorageWatchers(service);
  registerLifecycle(service);
  registerMessageHandler(service);
  if (import.meta.env.DEV) registerDevDiagnostics(service);
});

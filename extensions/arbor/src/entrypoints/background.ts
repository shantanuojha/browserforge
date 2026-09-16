/**
 * Background entrypoint: wires browser adapters to the background service. All behaviour lives
 * in `lib/background` and `lib/sync`; everything here is registration and adapter plumbing.
 */
import { createLogger, systemClock } from "@browserforge/shared";
import { defineBackground } from "wxt/utils/define-background";
import { browserAlarms } from "../adapters/alarms";
import { browserBackupStatusStore } from "../adapters/backup-status-store";
import { IndexedDbBackupStore } from "../adapters/backup-store";
import { IndexedDbTreeStore } from "../adapters/indexeddb-store";
import { onLicenseChange, proStatus, startLicenseRevalidation } from "../adapters/licensing";
import { listenForMessages } from "../adapters/messaging";
import { onInstalled, onStartup, onSuspend, openOptionsPage } from "../adapters/runtime";
import { browserSettingsStore } from "../adapters/settings-store";
import { installToolbarAction, openSidePanel } from "../adapters/side-panel";
import { browserTabsPort } from "../adapters/tabs-port";
import { bindTrackerEvents, onLiveFocusChanged } from "../adapters/tracker-events";
import { onTreePortConnect } from "../adapters/tree-port";
import { registerMessageHandlers } from "../lib/background/message-handler";
import { createArborBackground, type ArborBackground } from "../lib/background/service";
import { createTreeBroadcaster } from "../lib/background/tree-broadcaster";
import { newId } from "../lib/ids";
import { MessageRouter } from "../lib/messaging";

const log = createLogger("arbor:bg");

function createService(): ArborBackground {
  return createArborBackground({
    store: new IndexedDbTreeStore({ now: systemClock, logger: log.child("store") }),
    tabs: browserTabsPort,
    alarms: browserAlarms,
    backups: new IndexedDbBackupStore(),
    backupStatus: browserBackupStatusStore,
    settings: browserSettingsStore,
    proStatus,
    clock: systemClock,
    newId,
    logger: log,
  });
}

/**
 * `ready` already mirrors every open window on each service-worker start. These hooks re-run the
 * same reconciliation at the two lifecycle points where the browser's window list is most likely
 * to change right after we looked: a fresh install (windows may still be enumerating) and a
 * browser start (session restore recreates windows/tabs, sometimes seconds later).
 */
function registerLifecycle(service: ArborBackground): void {
  onInstalled(() => service.resync("installed"));
  onStartup(() => {
    service.resync("startup");
    service.scheduleStartupResync();
  });
  onLicenseChange(() => service.onLicenseChanged());
  browserAlarms.onAlarm((name) => service.handleAlarm(name));
  onSuspend(() => service.suspend());
}

function registerTreePush(service: ArborBackground): void {
  const broadcaster = createTreeBroadcaster({
    currentState: () => service.currentState(),
    ready: service.ready,
  });
  service.store.subscribe(() => broadcaster.scheduleBroadcast());
  onLiveFocusChanged(() => broadcaster.scheduleBroadcast());
  onTreePortConnect((sink) => broadcaster.accept(sink));
}

function registerMessages(service: ArborBackground): void {
  const router = registerMessageHandlers(new MessageRouter(), service, {
    async openSidePanel(windowId) {
      const target = windowId ?? (await browserTabsPort.currentWindowId());
      return target === undefined ? false : openSidePanel(target);
    },
  });
  listenForMessages(router);
}

export default defineBackground(() => {
  startLicenseRevalidation();
  const service = createService();
  bindTrackerEvents(service.tracker, service.ready);
  registerLifecycle(service);
  installToolbarAction(openOptionsPage);
  registerTreePush(service);
  registerMessages(service);
});

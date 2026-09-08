import { defineBackground } from "wxt/utils/define-background";
import { browser, type Browser } from "wxt/browser";
import { createLogger } from "@browserforge/shared";
import { BACKUP_ALARM, BackupScheduler, BackupStore } from "@/lib/backups";
import { createExport } from "@/lib/io/arbor-json";
import { MessageRouter } from "@/lib/messaging";
import {
  msg,
  TREE_PORT,
  type StartupInfo,
  type TreePortMessage,
  type TreeState,
} from "@/lib/messages";
import { makeNode, ops, serializeNodes, type OpBody, type TreeNode } from "@/lib/model";
import { newId } from "@/lib/ids";
import { onLicenseChange, setupLicensing } from "@/lib/licensing";
import { isPro } from "@/lib/pro";
import { loadSettings, watchSettings, type Settings } from "@/lib/settings";
import { IndexedDbTreeStore } from "@/lib/store/indexeddb";
import { bindTrackerEvents, browserTabsPort } from "@/lib/sync/browser-port";
import { TabTracker } from "@/lib/sync/tracker";

const COMPACT_ALARM = "arbor-compact-check";
/** One-shot re-sync after browser start: session restore can still be creating windows/tabs. */
const STARTUP_RESYNC_ALARM = "arbor-startup-resync";

/** `browser.sidePanel` only exists in Chromium 114+. */
function sidePanelApi(): typeof browser.sidePanel | undefined {
  const api = (browser as { sidePanel?: typeof browser.sidePanel }).sidePanel;
  return api && typeof api.open === "function" ? api : undefined;
}

/** MV3 `action` or MV2 `browserAction`, whichever this build has. */
function actionApi(): typeof browser.action | undefined {
  const b = browser as unknown as {
    action?: typeof browser.action;
    browserAction?: typeof browser.action;
  };
  return b.action ?? b.browserAction;
}

export default defineBackground(() => {
  const log = createLogger("arbor:bg");
  const store = new IndexedDbTreeStore();
  const tracker = new TabTracker(store, browserTabsPort);
  const backups = new BackupStore();
  const scheduler = new BackupScheduler(backups, () => store.getTree());
  const startup: StartupInfo = { report: null, rebuild: null, startedAt: Date.now() };
  let settings: Settings | null = null;

  // ---- licensing -----------------------------------------------------------------------------

  // Creates the Lemon Squeezy client (when this build is configured) and keeps the stored licence
  // fresh: a cheap validate() now, a forced one on the periodic alarm. Offline stays Pro for the
  // grace period. Nothing here runs when licensing is not configured.
  const license = setupLicensing();
  license?.scheduleRevalidation(browser.alarms);

  // ---- startup -------------------------------------------------------------------------------

  const ready: Promise<void> = (async () => {
    settings = await loadSettings();
    store.setCompactionInterval(settings.compactionIntervalMinutes * 60_000);
    startup.report = await store.open();
    if (startup.report.quarantined || startup.report.skippedSnapshots) {
      log.warn("recovered with issues", startup.report);
    }
    startup.rebuild = await tracker.rebuild();
    log.info("ready", startup.rebuild);
    await browser.alarms.create(COMPACT_ALARM, { periodInMinutes: 1 });
    await scheduler.configure(settings.backups, await isPro());
  })().catch((e: unknown) => {
    log.error("startup failed", e);
    throw e;
  });

  bindTrackerEvents(tracker, ready);

  // `ready` already mirrors every open window on each service-worker start. These hooks re-run the
  // same reconciliation at the two lifecycle points where the browser's window list is most likely
  // to change right after we looked: a fresh install (windows may still be enumerating) and a
  // browser start (session restore recreates windows/tabs, sometimes seconds later).
  const resync = async (why: string): Promise<void> => {
    await ready;
    startup.rebuild = await tracker.rebuild();
    log.info(`resync (${why})`, startup.rebuild);
  };
  browser.runtime.onInstalled.addListener(() => {
    void resync("installed").catch((e: unknown) => log.error("resync failed", e));
  });
  browser.runtime.onStartup.addListener(() => {
    void resync("startup").catch((e: unknown) => log.error("resync failed", e));
    // Alarms survive worker restarts; 30 s is the shortest delay Chrome allows in release builds.
    void browser.alarms.create(STARTUP_RESYNC_ALARM, { delayInMinutes: 0.5 }).catch(() => undefined);
  });

  watchSettings((next) => {
    settings = next;
    store.setCompactionInterval(next.compactionIntervalMinutes * 60_000);
    void ready.then(async () => scheduler.configure(next.backups, await isPro()));
  });

  // Activation, deactivation or a failed revalidation flips the Pro gate: re-arm or stop backups.
  onLicenseChange(() => {
    void ready.then(async () => {
      if (settings) await scheduler.configure(settings.backups, await isPro());
    });
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    void ready.then(async () => {
      if (alarm.name === COMPACT_ALARM) {
        await store.compactIfDue();
      } else if (alarm.name === STARTUP_RESYNC_ALARM) {
        await resync("startup+30s");
      } else if (alarm.name === BACKUP_ALARM) {
        if (!(await isPro()) || !settings?.backups.enabled) {
          await browser.alarms.clear(BACKUP_ALARM);
          return;
        }
        await scheduler.runNow(settings.backups.retention);
      }
    });
  });

  browser.runtime.onSuspend?.addListener(() => {
    void store.flush();
  });

  // ---- toolbar icon --------------------------------------------------------------------------

  const sidePanel = sidePanelApi();
  const action = actionApi();
  if (sidePanel && action) {
    // Chrome: the icon toggles the side panel directly; the popup is only for browsers without one.
    void sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
    void action.setPopup({ popup: "" }).catch(() => undefined);
  }
  action?.onClicked.addListener((tab) => {
    if (sidePanel && tab.windowId !== undefined) {
      void sidePanel
        .open({ windowId: tab.windowId })
        .catch(() => browser.runtime.openOptionsPage());
    } else {
      void browser.runtime.openOptionsPage();
    }
  });

  // ---- live tree push to side panels --------------------------------------------------------

  const ports = new Set<Browser.runtime.Port>();
  const currentState = (): TreeState => ({
    nodes: serializeNodes(store.getTree()),
    live: tracker.getLiveState(),
  });
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  const broadcast = (): void => {
    if (pushTimer !== null) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      if (!ports.size) return;
      const message: TreePortMessage = { type: "tree", state: currentState() };
      for (const port of ports) {
        try {
          port.postMessage(message);
        } catch {
          ports.delete(port);
        }
      }
    }, 80);
  };
  store.subscribe(() => broadcast());
  browser.tabs.onActivated.addListener(() => broadcast());
  browser.windows.onFocusChanged.addListener(() => broadcast());
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== TREE_PORT) return;
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
    void ready.then(() => {
      const message: TreePortMessage = { type: "tree", state: currentState() };
      port.postMessage(message);
    });
  });

  // ---- request/response API ------------------------------------------------------------------

  const router = new MessageRouter();
  const gated =
    <Req, Res>(fn: (req: Req) => Promise<Res> | Res) =>
    async (req: Req) => {
      await ready;
      return fn(req);
    };

  router
    .on(
      msg.getState,
      gated(() => currentState()),
    )
    .on(
      msg.getStartupInfo,
      gated(() => startup),
    )
    .on(
      msg.applyOps,
      gated((bodies) => store.append(bodies)),
    )
    .on(
      msg.moveNode,
      gated(({ id, parentId, index }) => tracker.moveNode(id, parentId, index)),
    )
    .on(
      msg.focusNode,
      gated(({ id }) => tracker.focus(id)),
    )
    .on(
      msg.restoreNode,
      gated(({ id }) => tracker.restore(id)),
    )
    .on(
      msg.closeAndSave,
      gated(({ id }) => tracker.closeAndSave(id)),
    )
    .on(
      msg.closeAllAndSave,
      gated(() => tracker.closeAllAndSave()),
    )
    .on(
      msg.deleteNode,
      gated(async ({ id }) => {
        // Remove from the tree first so the resulting tab events do not re-save the nodes.
        const liveIds = tracker.liveTabIdsIn(id);
        if (store.getTree().has(id)) store.append([ops.remove(id)]);
        if (liveIds.length) await browserTabsPort.removeTabs(liveIds);
      }),
    )
    .on(
      msg.addNode,
      gated(({ parentId, index, kind, title }) => {
        const node = makeNode({ id: newId(), parentId, kind, title });
        store.append([ops.add(node, index)]);
        return node;
      }),
    )
    .on(
      msg.listSnapshots,
      gated(() => store.listSnapshots()),
    )
    .on(
      msg.restoreSnapshot,
      gated(async ({ seq }) => {
        const tree = await store.restoreSnapshot(seq);
        startup.rebuild = await tracker.rebuild();
        return tree.size;
      }),
    )
    .on(
      msg.listQuarantine,
      gated(() => store.listQuarantine()),
    )
    .on(
      msg.compactNow,
      gated(async () => {
        const snap = await store.compact(true);
        return snap ? { seq: snap.seq, ts: snap.ts, nodeCount: snap.nodeCount } : null;
      }),
    )
    .on(
      msg.exportTree,
      gated(() => createExport(store.getTree())),
    )
    .on(
      msg.importNodes,
      gated(async ({ nodes, mode }) => {
        if (mode === "replace") {
          const saved: TreeNode[] = nodes.map((n) => {
            const copy = { ...n };
            delete copy.liveTabId;
            delete copy.liveWindowId;
            return copy;
          });
          await store.replaceTree(saved);
          startup.rebuild = await tracker.rebuild();
          return saved.length;
        }
        const batch: OpBody[] = nodes.map((n) => ops.add(n));
        for (let i = 0; i < batch.length; i += 500) store.append(batch.slice(i, i + 500));
        await store.flush();
        return nodes.length;
      }),
    )
    .on(
      msg.listBackups,
      gated(() => backups.list()),
    )
    .on(
      msg.runBackupNow,
      gated(async () => {
        if (!(await isPro())) throw new Error("Scheduled backups are a Pro feature");
        return scheduler.runNow(settings?.backups.retention ?? 10);
      }),
    )
    .on(
      msg.getBackup,
      gated(async ({ ts }) => (await backups.get(ts))?.data ?? null),
    )
    .on(
      msg.deleteBackup,
      gated(({ ts }) => backups.delete(ts)),
    )
    .on(
      msg.openSidePanel,
      gated(async ({ windowId }) => {
        const api = sidePanelApi();
        if (!api) return false;
        const target = windowId ?? (await browserTabsPort.currentWindowId());
        if (target === undefined) return false;
        await api.open({ windowId: target });
        return true;
      }),
    )
    .listen();
});

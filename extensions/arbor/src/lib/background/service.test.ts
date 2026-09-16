import { describe, expect, it, vi } from "vitest";
import type { Logger } from "@browserforge/shared";
import {
  BACKUP_ALARM,
  type BackupRecord,
  type BackupRepository,
  type ScheduledRun,
} from "../backups";
import { messages } from "../messages";
import { MessageRouter, envelopeFor } from "../messaging";
import { makeNode, ops } from "../model";
import type { ProStatus } from "../pro";
import { DEFAULT_SETTINGS, type Settings } from "../settings";
import { MemoryTreeStore } from "../store/memory";
import { FakeBrowser, newId } from "../sync/testing/fake-browser";
import { registerMessageHandlers } from "./message-handler";
import type { AlarmsPort, AlarmSchedule, BackupStatusStore, SettingsStore } from "./ports";
import { COMPACT_ALARM, STARTUP_RESYNC_ALARM, createArborBackground } from "./service";
import { createTreeBroadcaster, type TreePortSink } from "./tree-broadcaster";

function fakeAlarms(initial: Record<string, AlarmSchedule> = {}) {
  const alarms = new Map<string, AlarmSchedule>(Object.entries(initial));
  const scheduledTimes = new Map<string, number>();
  const created: string[] = [];
  const listeners: ((name: string) => void)[] = [];
  const port: AlarmsPort = {
    async create(name, schedule) {
      alarms.set(name, schedule);
      scheduledTimes.delete(name);
      created.push(name);
    },
    async get(name) {
      const schedule = alarms.get(name);
      const scheduledTime = scheduledTimes.get(name);
      if (!schedule || scheduledTime === undefined) return schedule;
      return { ...schedule, scheduledTime };
    },
    async clear(name) {
      alarms.delete(name);
    },
    onAlarm(listener) {
      listeners.push(listener);
    },
  };
  return {
    port,
    alarms,
    created,
    fire: (name: string) => listeners.forEach((l) => l(name)),
    /** Pretend Chrome reports `scheduledTime` for the alarm (it fires late, never early). */
    reportNextFire: (name: string, scheduledTime: number) =>
      scheduledTimes.set(name, scheduledTime),
  };
}

function fakeBackupStatus() {
  const runs: ScheduledRun[] = [];
  const store: BackupStatusStore = {
    async save(run) {
      runs.push(run);
    },
  };
  return { store, runs, last: () => runs.at(-1) };
}

function fakeBackups() {
  const records = new Map<number, BackupRecord>();
  const repository: BackupRepository = {
    async list() {
      return [...records.values()]
        .map((r) => ({ ts: r.ts, nodeCount: r.nodeCount }))
        .sort((a, b) => b.ts - a.ts);
    },
    async get(ts) {
      return records.get(ts);
    },
    async put(record) {
      records.set(record.ts, record);
    },
    async delete(ts) {
      records.delete(ts);
    },
  };
  return { repository, records };
}

function fakeSettings(initial: Settings = DEFAULT_SETTINGS) {
  let watcher: ((settings: Settings) => void) | undefined;
  const store: SettingsStore = {
    load: async () => initial,
    watch(callback) {
      watcher = callback;
      return () => undefined;
    },
  };
  return { store, change: (next: Settings) => watcher?.(next) };
}

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

interface HarnessOptions {
  pro?: ProStatus;
  settings?: Settings;
  /** Alarms that survived from a previous worker life. */
  existingAlarms?: Record<string, AlarmSchedule>;
}

async function harness(options: HarnessOptions = {}) {
  const store = new MemoryTreeStore();
  const fb = new FakeBrowser();
  const w = fb.addWindow();
  fb.addTab(w.id, "https://a.test/", "A");
  const alarms = fakeAlarms(options.existingAlarms);
  const backups = fakeBackups();
  const status = fakeBackupStatus();
  const settings = fakeSettings(options.settings);
  let clock = 1_000;
  const pro = { value: options.pro ?? "free" };
  const service = createArborBackground({
    store,
    tabs: fb,
    alarms: alarms.port,
    backups: backups.repository,
    backupStatus: status.store,
    settings: settings.store,
    proStatus: async () => pro.value,
    clock: () => clock++,
    newId,
    logger: silentLogger,
  });
  fb.tracker = service.tracker;
  await service.ready;
  return { service, store, fb, w, alarms, backups, status, settings, pro };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Settings with the backup schedule on, as a Pro user would have them. */
function scheduled(overrides: Partial<Settings["backups"]> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    backups: { ...DEFAULT_SETTINGS.backups, enabled: true, intervalMinutes: 10, ...overrides },
  };
}

const armedEvery = (minutes: number): AlarmSchedule => ({
  periodInMinutes: minutes,
  delayInMinutes: minutes,
});

describe("ArborBackground startup", () => {
  it("opens the store, mirrors the browser and arms the compaction alarm", async () => {
    const { service, store, alarms } = await harness();
    expect(service.startup.report).toMatchObject({ snapshotSeq: 0, replayed: 0 });
    expect(service.startup.rebuild).toMatchObject({ windowsCreated: 1, tabsCreated: 1 });
    expect(store.getTree().size).toBe(2);
    expect(alarms.alarms.get(COMPACT_ALARM)).toEqual({ periodInMinutes: 1 });
    expect(alarms.alarms.has(BACKUP_ALARM)).toBe(false);
  });

  it("applies the compaction interval from settings", async () => {
    const settings = { ...DEFAULT_SETTINGS, compactionIntervalMinutes: 7 };
    const { store } = await harness({ settings });
    store.append([ops.add(makeNode({ id: "n", parentId: null, kind: "note", title: "n", ts: 1 }))]);
    // Not due: the interval is 7 minutes and the clock has barely moved.
    expect(await store.compactIfDue(2_000)).toBe(false);
    expect(await store.compactIfDue(2_000 + 7 * 60_000)).toBe(true);
  });

  it("arms the backup alarm only for Pro users with backups enabled", async () => {
    const settings = scheduled({ intervalMinutes: 30 });
    const { alarms } = await harness({ pro: "pro", settings });
    expect(alarms.alarms.get(BACKUP_ALARM)).toEqual(armedEvery(30));
    const free = await harness({ pro: "free", settings });
    expect(free.alarms.alarms.has(BACKUP_ALARM)).toBe(false);
  });

  it("arms the backup alarm when the licence cannot be checked at start", async () => {
    const { alarms } = await harness({ pro: "unknown", settings: scheduled() });
    expect(alarms.alarms.get(BACKUP_ALARM)).toEqual(armedEvery(10));
  });

  it("re-creates a backup alarm the browser lost, and leaves a matching one alone", async () => {
    const lost = await harness({ pro: "pro", settings: scheduled() });
    expect(lost.alarms.created).toContain(BACKUP_ALARM);

    const kept = await harness({
      pro: "pro",
      settings: scheduled(),
      existingAlarms: { [BACKUP_ALARM]: armedEvery(10) },
    });
    expect(kept.alarms.created).not.toContain(BACKUP_ALARM);
    expect(kept.alarms.alarms.get(BACKUP_ALARM)).toEqual(armedEvery(10));
  });

  it("clears a surviving backup alarm when the licence is definitely free", async () => {
    const { alarms } = await harness({
      pro: "free",
      settings: scheduled(),
      existingAlarms: { [BACKUP_ALARM]: armedEvery(10) },
    });
    expect(alarms.alarms.has(BACKUP_ALARM)).toBe(false);
  });

  it("re-arms or stops backups when settings or the licence change", async () => {
    const { service, alarms, settings, pro } = await harness({ pro: "pro" });
    expect(alarms.alarms.has(BACKUP_ALARM)).toBe(false);
    settings.change(scheduled({ intervalMinutes: 15 }));
    await tick();
    expect(alarms.alarms.get(BACKUP_ALARM)).toEqual(armedEvery(15));
    pro.value = "free";
    service.onLicenseChanged();
    await tick();
    expect(alarms.alarms.has(BACKUP_ALARM)).toBe(false);
  });

  it("a settings change that keeps the period does not reschedule the alarm", async () => {
    const { alarms, settings } = await harness({ pro: "pro", settings: scheduled() });
    const before = alarms.created.filter((n) => n === BACKUP_ALARM).length;
    settings.change({ ...scheduled(), theme: "dark", confirmCloseAll: false });
    settings.change(scheduled({ retention: 3 }));
    await tick();
    expect(alarms.created.filter((n) => n === BACKUP_ALARM).length).toBe(before);
    settings.change(scheduled({ intervalMinutes: 20 }));
    await tick();
    expect(alarms.created.filter((n) => n === BACKUP_ALARM).length).toBe(before + 1);
    expect(alarms.alarms.get(BACKUP_ALARM)).toEqual(armedEvery(20));
  });

  it("reschedules an alarm whose next fire is stranded past one period", async () => {
    const { service, alarms } = await harness({ pro: "pro", settings: scheduled() });
    const before = alarms.created.length;
    // The harness clock sits near epoch; a next fire an hour out means the wall clock jumped back.
    alarms.reportNextFire(BACKUP_ALARM, 60 * 60_000);
    service.onLicenseChanged();
    await tick();
    expect(alarms.created.length).toBe(before + 1);
    // Rescheduled alarms report a sane next fire and are then left alone.
    alarms.reportNextFire(BACKUP_ALARM, 10 * 60_000);
    service.onLicenseChanged();
    await tick();
    expect(alarms.created.length).toBe(before + 1);
  });
});

describe("ArborBackground scheduled backups", () => {
  it("runs a scheduled backup, trims to the retention and records the run", async () => {
    const { service, backups, status } = await harness({
      pro: "pro",
      settings: scheduled({ retention: 2 }),
    });
    for (let i = 0; i < 3; i++) {
      service.handleAlarm(BACKUP_ALARM);
      await tick();
    }
    expect(backups.records.size).toBe(2);
    expect(status.runs).toHaveLength(3);
    expect(status.last()).toMatchObject({ outcome: { kind: "written", nodeCount: 2 } });
  });

  it("a tick that cannot check the licence skips, keeps the alarm, and the next tick writes", async () => {
    const { service, alarms, backups, status, pro } = await harness({
      pro: "pro",
      settings: scheduled(),
    });
    pro.value = "unknown";
    service.handleAlarm(BACKUP_ALARM);
    await tick();
    expect(backups.records.size).toBe(0);
    expect(alarms.alarms.get(BACKUP_ALARM)).toEqual(armedEvery(10));
    expect(status.last()).toMatchObject({
      outcome: { kind: "skipped", reason: "licence-unavailable" },
    });

    pro.value = "pro";
    service.handleAlarm(BACKUP_ALARM);
    await tick();
    expect(backups.records.size).toBe(1);
    expect(status.last()?.outcome.kind).toBe("written");
  });

  it("a tick that finds the licence definitely free clears the alarm", async () => {
    const { service, alarms, backups, status, pro } = await harness({
      pro: "pro",
      settings: scheduled(),
    });
    pro.value = "free";
    service.handleAlarm(BACKUP_ALARM);
    await tick();
    expect(alarms.alarms.has(BACKUP_ALARM)).toBe(false);
    expect(backups.records.size).toBe(0);
    expect(status.last()).toMatchObject({ outcome: { kind: "skipped", reason: "not-pro" } });
  });

  it("a tick re-creates the alarm when the browser has dropped it", async () => {
    const { service, alarms, backups } = await harness({ pro: "pro", settings: scheduled() });
    alarms.alarms.delete(BACKUP_ALARM);
    service.handleAlarm(BACKUP_ALARM);
    await tick();
    expect(alarms.alarms.get(BACKUP_ALARM)).toEqual(armedEvery(10));
    expect(backups.records.size).toBe(1);
  });

  it("a tick after the schedule was switched off clears the alarm and says so", async () => {
    const { service, alarms, status, settings } = await harness({
      pro: "pro",
      settings: scheduled(),
    });
    settings.change(scheduled({ enabled: false }));
    await tick();
    expect(alarms.alarms.has(BACKUP_ALARM)).toBe(false);
    service.handleAlarm(BACKUP_ALARM); // already in flight when the user flipped the switch
    await tick();
    expect(status.last()).toMatchObject({ outcome: { kind: "skipped", reason: "disabled" } });
  });

  it("a failed write is recorded and leaves the alarm armed", async () => {
    const { service, alarms, backups, status } = await harness({
      pro: "pro",
      settings: scheduled(),
    });
    backups.repository.put = async () => {
      throw new Error("quota exceeded");
    };
    service.handleAlarm(BACKUP_ALARM);
    await tick();
    expect(alarms.alarms.get(BACKUP_ALARM)).toEqual(armedEvery(10));
    expect(status.last()).toMatchObject({
      outcome: { kind: "failed", error: "quota exceeded" },
    });
  });

  it("stamps each run with the clock", async () => {
    const { service, status } = await harness({ pro: "pro", settings: scheduled() });
    service.handleAlarm(BACKUP_ALARM);
    await tick();
    expect(status.last()?.at).toBeGreaterThanOrEqual(1_000);
  });
});

describe("ArborBackground alarms", () => {
  it("re-syncs on the startup alarm and ignores alarms it does not own", async () => {
    const { service, fb, w, store } = await harness();
    fb.addTab(w.id, "https://b.test/", "B"); // appeared while we were not looking
    service.handleAlarm("someone-elses-alarm");
    service.handleAlarm(STARTUP_RESYNC_ALARM);
    await tick();
    expect([...store.getTree().values()].filter((n) => n.kind === "tab").length).toBe(2);
    expect(service.startup.rebuild?.tabsCreated).toBe(1);
  });

  it("schedules the one-shot startup resync alarm", async () => {
    const { service, alarms } = await harness();
    service.scheduleStartupResync();
    await tick();
    expect(alarms.alarms.get(STARTUP_RESYNC_ALARM)).toEqual({ delayInMinutes: 0.5 });
  });
});

describe("ArborBackground operations", () => {
  it("addNode appends a saved node at the requested index", async () => {
    const { service, store } = await harness();
    const node = service.addNode({ parentId: null, index: 0, kind: "window", title: "New group" });
    expect(store.getTree().get(node.id)).toMatchObject({ title: "New group", order: 0 });
    expect(node.liveWindowId).toBeUndefined();
  });

  it("importNodes in replace mode strips live ids and re-links open tabs by url", async () => {
    const { service, store, w } = await harness();
    const nodes = [
      makeNode({ id: "iw", parentId: null, kind: "window", title: "", liveWindowId: 999, ts: 1 }),
      makeNode({
        id: "it",
        parentId: "iw",
        kind: "tab",
        title: "A",
        url: "https://a.test/",
        liveTabId: 999,
        ts: 1,
      }),
    ];
    expect(await service.importNodes(nodes, "replace")).toBe(2);
    const tree = store.getTree();
    expect(tree.get("iw")?.liveWindowId).toBe(w.id);
    expect(tree.get("it")?.liveTabId).toBeDefined();
    expect(tree.get("it")?.liveTabId).not.toBe(999);
  });

  it("importNodes in merge mode appends the nodes as given", async () => {
    const { service, store } = await harness();
    const before = store.getTree().size;
    const nodes = [makeNode({ id: "g", parentId: null, kind: "window", title: "G", ts: 1 })];
    expect(await service.importNodes(nodes, "merge")).toBe(1);
    expect(store.getTree().size).toBe(before + 1);
  });

  it("runBackupNow is a Pro feature and refuses when the licence cannot be checked", async () => {
    const free = await harness();
    await expect(free.service.runBackupNow()).rejects.toThrow(/Pro feature/);
    const unknown = await harness({ pro: "unknown" });
    await expect(unknown.service.runBackupNow()).rejects.toThrow(/Could not check/);
    expect(unknown.backups.records.size).toBe(0);
    const pro = await harness({ pro: "pro" });
    const meta = await pro.service.runBackupNow();
    expect(pro.backups.records.get(meta.ts)?.nodeCount).toBe(meta.nodeCount);
  });

  it("compactNow writes a snapshot and restoreSnapshot brings it back", async () => {
    const { service, store } = await harness();
    const meta = await service.compactNow();
    expect(meta?.nodeCount).toBe(2);
    service.addNode({ parentId: null, kind: "note", title: "later" });
    expect(await service.restoreSnapshot(meta?.seq ?? -1)).toBe(2);
    expect(store.getTree().size).toBe(2);
  });
});

describe("message handlers", () => {
  it("route every message to the service and report handler errors", async () => {
    const { service } = await harness();
    const openSidePanel = vi.fn(async () => true);
    const router = registerMessageHandlers(new MessageRouter(), service, { openSidePanel });
    const send = (envelope: unknown) => router.dispatch(envelope, {});

    const state = await send(envelopeFor(messages.getState, undefined));
    expect(state).toMatchObject({ ok: true, value: { nodes: expect.any(Array) } });

    const added = await send(
      envelopeFor(messages.addNode, { parentId: null, kind: "note", title: "n" }),
    );
    expect(added).toMatchObject({ ok: true, value: { kind: "note", title: "n" } });

    expect(await send(envelopeFor(messages.openSidePanel, { windowId: 4 }))).toEqual({
      ok: true,
      value: true,
    });
    expect(openSidePanel).toHaveBeenCalledWith(4);

    expect(await send(envelopeFor(messages.runBackupNow, undefined))).toEqual({
      ok: false,
      error: "Scheduled backups are a Pro feature",
    });
    expect(await send({ unrelated: true })).toBeUndefined();
  });
});

describe("tree broadcaster", () => {
  it("sends the tree to new panels once ready and coalesces bursts", async () => {
    vi.useFakeTimers();
    try {
      let version = 0;
      const broadcaster = createTreeBroadcaster({
        currentState: () => ({
          nodes: [],
          live: { activeTabIds: [version++], focusedWindowId: undefined },
        }),
        ready: Promise.resolve(),
        debounceMs: 80,
      });
      const posted: unknown[] = [];
      let disconnect: (() => void) | undefined;
      const sink: TreePortSink = {
        post: (m) => posted.push(m),
        onDisconnect: (listener) => (disconnect = listener),
      };
      broadcaster.accept(sink);
      await Promise.resolve();
      expect(posted.length).toBe(1);

      broadcaster.scheduleBroadcast();
      broadcaster.scheduleBroadcast();
      broadcaster.scheduleBroadcast();
      await vi.advanceTimersByTimeAsync(100);
      expect(posted.length).toBe(2);

      disconnect?.();
      broadcaster.scheduleBroadcast();
      await vi.advanceTimersByTimeAsync(100);
      expect(posted.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

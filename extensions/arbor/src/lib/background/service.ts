/**
 * Composes the background: opens the store, rebuilds the tree from the browser, keeps the
 * compaction and backup alarms honest, and offers the operations the message handlers call.
 * Everything the browser provides arrives through ports, so the whole orchestration runs in unit
 * tests with in-memory fakes. `entrypoints/background.ts` only wires adapters to this.
 */
import type { Clock, Logger } from "@browserforge/shared";
import {
  BACKUP_ALARM,
  BackupScheduler,
  describeScheduledOutcome,
  type BackupMeta,
  type BackupRepository,
} from "../backups";
import { createExport } from "../io/arbor-json";
import type { StartupInfo, TreeState } from "../messages";
import { makeNode, ops, serializeNodes, type NodeId, type NodeKind, type TreeNode } from "../model";
import type { ProStatus } from "../pro";
import { compactionIntervalMs, type Settings } from "../settings";
import type { SnapshotMeta, TreeStore } from "../store/types";
import { TabTracker } from "../sync/tracker";
import type { TabsPort } from "../sync/types";
import type { AlarmsPort, BackupStatusStore, SettingsStore } from "./ports";
import { asSavedNodes } from "./import";

export const COMPACT_ALARM = "arbor-compact-check";
/** One-shot re-sync after browser start: session restore can still be creating windows/tabs. */
export const STARTUP_RESYNC_ALARM = "arbor-startup-resync";
/** Alarms survive worker restarts; 30 s is the shortest delay Chrome allows in release builds. */
const STARTUP_RESYNC_DELAY_MINUTES = 0.5;
/** Merge imports append in chunks so one giant batch cannot stall the panel. */
const IMPORT_CHUNK = 500;

export interface BackgroundDeps {
  store: TreeStore;
  tabs: TabsPort;
  alarms: AlarmsPort;
  backups: BackupRepository;
  backupStatus: BackupStatusStore;
  settings: SettingsStore;
  /** Cached licence state; `unknown` when the check itself failed (see `lib/pro.ts`). */
  proStatus(): Promise<ProStatus>;
  clock: Clock;
  newId(): string;
  logger: Logger;
}

export interface AddNodeInput {
  parentId: NodeId | null;
  index?: number | undefined;
  kind: NodeKind;
  title: string;
}

export type ImportMode = "merge" | "replace";

export interface ArborBackground {
  /** Resolves once the store is open and the browser has been mirrored. */
  readonly ready: Promise<void>;
  readonly store: TreeStore;
  readonly tracker: TabTracker;
  readonly backups: BackupRepository;
  readonly startup: StartupInfo;
  currentState(): TreeState;
  /** Run `fn` once startup finished (every message handler is gated this way). */
  whenReady<T>(fn: () => Promise<T> | T): Promise<T>;
  /** Mirror the browser again; failures are logged, not thrown. */
  resync(why: string): void;
  /** Arm the one-shot alarm that re-syncs after a browser start. */
  scheduleStartupResync(): void;
  handleAlarm(name: string): void;
  /**
   * The stored licence changed (activation, deactivation, a revalidation verdict): re-arm or
   * stop backups. Not fired on plain worker start; `ready` covers that.
   */
  onLicenseChanged(): void;
  /** The worker is about to be suspended: write what is pending. */
  suspend(): void;
  addNode(input: AddNodeInput): TreeNode;
  importNodes(nodes: readonly TreeNode[], mode: ImportMode): Promise<number>;
  restoreSnapshot(seq: number): Promise<number>;
  compactNow(): Promise<SnapshotMeta | null>;
  runBackupNow(): Promise<BackupMeta>;
  exportTree(): ReturnType<typeof createExport>;
}

class ArborBackgroundService implements ArborBackground {
  readonly store: TreeStore;
  readonly tracker: TabTracker;
  readonly backups: BackupRepository;
  readonly startup: StartupInfo;
  readonly ready: Promise<void>;
  private readonly scheduler: BackupScheduler;
  private settings: Settings | null = null;

  constructor(private readonly deps: BackgroundDeps) {
    this.store = deps.store;
    this.backups = deps.backups;
    this.tracker = new TabTracker(deps.store, deps.tabs, { newId: deps.newId, clock: deps.clock });
    this.scheduler = new BackupScheduler({
      backups: deps.backups,
      alarms: deps.alarms,
      getTree: () => deps.store.getTree(),
      clock: deps.clock,
    });
    this.startup = { report: null, rebuild: null, startedAt: deps.clock() };
    this.ready = this.start().catch((e: unknown) => {
      deps.logger.error("startup failed", e);
      throw e;
    });
    deps.settings.watch((next) => this.applySettings(next));
  }

  private async start(): Promise<void> {
    const { store, alarms, settings, logger } = this.deps;
    this.settings = await settings.load();
    store.setCompactionInterval(compactionIntervalMs(this.settings));
    this.startup.report = await store.open();
    if (this.startup.report.quarantined || this.startup.report.skippedSnapshots) {
      logger.warn("recovered with issues", this.startup.report);
    }
    this.startup.rebuild = await this.tracker.rebuild();
    logger.info("ready", this.startup.rebuild);
    await alarms.create(COMPACT_ALARM, { periodInMinutes: 1 });
    await this.ensureBackupSchedule();
  }

  /**
   * Keeps the backup alarm true to settings and licence. Runs on every worker start (alarms are
   * not guaranteed to survive a browser restart) and on settings and licence changes.
   */
  private async ensureBackupSchedule(): Promise<void> {
    if (!this.settings) return;
    await this.scheduler.ensureScheduled(this.settings.backups, await this.deps.proStatus());
  }

  private applySettings(next: Settings): void {
    this.settings = next;
    this.store.setCompactionInterval(compactionIntervalMs(next));
    void this.whenReady(() => this.ensureBackupSchedule()).catch(this.reportFailure("settings"));
  }

  private reportFailure(what: string): (e: unknown) => void {
    return (e) => this.deps.logger.error(`${what} failed`, e);
  }

  currentState(): TreeState {
    return { nodes: serializeNodes(this.store.getTree()), live: this.tracker.getLiveState() };
  }

  async whenReady<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.ready;
    return fn();
  }

  resync(why: string): void {
    void this.whenReady(async () => {
      this.startup.rebuild = await this.tracker.rebuild();
      this.deps.logger.info(`resync (${why})`, this.startup.rebuild);
    }).catch(this.reportFailure("resync"));
  }

  scheduleStartupResync(): void {
    void this.deps.alarms
      .create(STARTUP_RESYNC_ALARM, { delayInMinutes: STARTUP_RESYNC_DELAY_MINUTES })
      .catch(() => undefined); // no alarms API: the startup resync already ran
  }

  handleAlarm(name: string): void {
    const handlers: Record<string, () => Promise<unknown>> = {
      [COMPACT_ALARM]: () => this.store.compactIfDue(),
      [STARTUP_RESYNC_ALARM]: async () => this.resync("startup+30s"),
      [BACKUP_ALARM]: () => this.runScheduledBackup(),
    };
    const handler = handlers[name];
    if (handler) void this.whenReady(handler).catch(this.reportFailure(`alarm ${name}`));
  }

  /** One tick of the backup alarm; the outcome is logged and kept for the Options page. */
  private async runScheduledBackup(): Promise<void> {
    if (!this.settings) return;
    const pro = await this.deps.proStatus();
    const run = await this.scheduler.runScheduled(this.settings.backups, pro);
    const summary = `scheduled backup ${describeScheduledOutcome(run.outcome)}`;
    if (run.outcome.kind === "written") this.deps.logger.info(summary);
    else this.deps.logger.warn(summary);
    await this.deps.backupStatus.save(run);
  }

  onLicenseChanged(): void {
    void this.whenReady(() => this.ensureBackupSchedule()).catch(
      this.reportFailure("licence change"),
    );
  }

  suspend(): void {
    void this.store.flush();
  }

  addNode({ parentId, index, kind, title }: AddNodeInput): TreeNode {
    const node = makeNode({ id: this.deps.newId(), parentId, kind, title, ts: this.deps.clock() });
    this.store.append([ops.add(node, index)]);
    return node;
  }

  async importNodes(nodes: readonly TreeNode[], mode: ImportMode): Promise<number> {
    if (mode === "replace") {
      const saved = asSavedNodes(nodes);
      await this.store.replaceTree(saved);
      this.startup.rebuild = await this.tracker.rebuild();
      return saved.length;
    }
    const batch = nodes.map((n) => ops.add(n));
    for (let i = 0; i < batch.length; i += IMPORT_CHUNK) {
      this.store.append(batch.slice(i, i + IMPORT_CHUNK));
    }
    await this.store.flush();
    return nodes.length;
  }

  async restoreSnapshot(seq: number): Promise<number> {
    const tree = await this.store.restoreSnapshot(seq);
    this.startup.rebuild = await this.tracker.rebuild();
    return tree.size;
  }

  async compactNow(): Promise<SnapshotMeta | null> {
    const snap = await this.store.compact(true);
    return snap ? { seq: snap.seq, ts: snap.ts, nodeCount: snap.nodeCount } : null;
  }

  async runBackupNow(): Promise<BackupMeta> {
    const pro = await this.deps.proStatus();
    if (pro === "unknown") throw new Error("Could not check the Pro licence; try again");
    if (pro === "free") throw new Error("Scheduled backups are a Pro feature");
    return this.scheduler.runNow(this.settings?.backups.retention ?? 10);
  }

  exportTree(): ReturnType<typeof createExport> {
    return createExport(this.store.getTree(), this.deps.clock());
  }
}

export function createArborBackground(deps: BackgroundDeps): ArborBackground {
  return new ArborBackgroundService(deps);
}

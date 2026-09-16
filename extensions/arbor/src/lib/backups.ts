/**
 * Pro: scheduled local backups.
 *
 * The extension has no `downloads` permission, so a backup is a full export written to a
 * `BackupRepository` on a timer; the Options page lists them and lets the user save any of them
 * as a file. Retention keeps the newest N. The repository is a port (`adapters/backup-store.ts`
 * keeps it in IndexedDB); the alarm that drives the schedule is another (`AlarmsPort`).
 *
 * The alarm is something to keep true, not something set once: Chrome documents that an alarm
 * may not survive a browser restart, so `ensureScheduled` runs on every worker start and every
 * tick. Only two things disarm it: the user turning the schedule off, or a Pro check that
 * succeeded and said `free`. A check that could not run must not stop backups.
 *
 * What this module cannot fix: the browser itself may hold an alarm back (Chrome guarantees only
 * "at most once every 30 s, possibly delayed"; Edge's efficiency mode and device sleep delay
 * alarms further). The `ScheduledRun` record makes such gaps visible in the Options page.
 */
import { errorMessage, isRecord, type Clock } from "@browserforge/shared";
import type { AlarmInfo, AlarmsPort } from "./background/ports";
import { createExport, type ArborExport } from "./io/arbor-json";
import type { Tree } from "./model";
import type { ProStatus } from "./pro";

export const BACKUP_ALARM = "arbor-scheduled-backup";
/** `browser.storage.local` key holding the `ScheduledRun` of the last tick. */
export const BACKUP_STATUS_KEY = "arbor:backup-status";
/** Chrome may fire an alarm late, never early; a next fire further out than this is stranded. */
const SCHEDULE_TOLERANCE_MS = 60_000;

export interface BackupRecord {
  ts: number;
  nodeCount: number;
  data: ArborExport;
}

export interface BackupMeta {
  ts: number;
  nodeCount: number;
}

/** Where backups live. `list` returns the newest first. */
export interface BackupRepository {
  list(): Promise<BackupMeta[]>;
  get(ts: number): Promise<BackupRecord | undefined>;
  put(record: BackupRecord): Promise<void>;
  delete(ts: number): Promise<void>;
}

/** Keep only the newest `retention` backups (at least one). Returns how many were removed. */
export async function trimBackups(
  repository: BackupRepository,
  retention: number,
): Promise<number> {
  const all = await repository.list();
  const excess = all.slice(Math.max(1, retention));
  for (const b of excess) await repository.delete(b.ts);
  return excess.length;
}

export interface BackupSchedule {
  enabled: boolean;
  intervalMinutes: number;
  retention: number;
}

/* ------------------------------------------------------------------------------------------ */
/* What a tick did                                                                              */

/** Why a tick wrote nothing. */
export type ScheduledSkipReason = "licence-unavailable" | "not-pro" | "disabled";

export type ScheduledOutcome =
  | { kind: "written"; nodeCount: number }
  | { kind: "skipped"; reason: ScheduledSkipReason }
  | { kind: "failed"; error: string };

/** What the last alarm tick did, kept for the Options page and the log. */
export interface ScheduledRun {
  at: number;
  outcome: ScheduledOutcome;
}

const SKIP_TEXT: Record<ScheduledSkipReason, string> = {
  "licence-unavailable": "skipped: licence check unavailable",
  "not-pro": "skipped: not Pro",
  disabled: "skipped: schedule off",
};

/** One line for the Options page and the log: "written (112 nodes)", "skipped: not Pro". */
export function describeScheduledOutcome(outcome: ScheduledOutcome): string {
  switch (outcome.kind) {
    case "written":
      return `written (${outcome.nodeCount} nodes)`;
    case "skipped":
      return SKIP_TEXT[outcome.reason];
    case "failed":
      return `failed: ${outcome.error}`;
  }
}

function isSkipReason(value: unknown): value is ScheduledSkipReason {
  return typeof value === "string" && value in SKIP_TEXT;
}

function parseOutcome(raw: unknown): ScheduledOutcome | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.kind === "written" && typeof raw.nodeCount === "number") {
    return { kind: "written", nodeCount: raw.nodeCount };
  }
  if (raw.kind === "skipped" && isSkipReason(raw.reason)) {
    return { kind: "skipped", reason: raw.reason };
  }
  if (raw.kind === "failed" && typeof raw.error === "string") {
    return { kind: "failed", error: raw.error };
  }
  return undefined;
}

/** Reads a stored `ScheduledRun`; anything malformed reads as "no run recorded". */
export function parseScheduledRun(raw: unknown): ScheduledRun | undefined {
  if (!isRecord(raw) || typeof raw.at !== "number") return undefined;
  const outcome = parseOutcome(raw.outcome);
  return outcome ? { at: raw.at, outcome } : undefined;
}

/* ------------------------------------------------------------------------------------------ */
/* The scheduler                                                                                */

export interface BackupSchedulerDeps {
  backups: BackupRepository;
  alarms: AlarmsPort;
  getTree: () => Tree;
  clock: Clock;
}

/** The alarm should exist unless the user said no or the licence is known to be free. */
function wantsAlarm(schedule: BackupSchedule, pro: ProStatus): boolean {
  return schedule.enabled && pro !== "free";
}

function skipReason(pro: ProStatus): ScheduledSkipReason {
  return pro === "free" ? "not-pro" : "licence-unavailable";
}

/**
 * Owns the backup alarm and writes backups. The background hands in the settings and what it
 * knows about Pro; the scheduler decides what that means for the alarm.
 */
export class BackupScheduler {
  constructor(private readonly deps: BackupSchedulerDeps) {}

  /**
   * Makes the alarm match `schedule` and `pro`. Idempotent: an alarm that already has the right
   * period and a plausible next fire is left untouched, so a worker restart never reschedules
   * it. On `unknown` the alarm is kept (or created) exactly as for `pro`.
   */
  async ensureScheduled(schedule: BackupSchedule, pro: ProStatus): Promise<void> {
    const { alarms } = this.deps;
    const existing = await alarms.get(BACKUP_ALARM);
    if (!wantsAlarm(schedule, pro)) {
      if (existing) await alarms.clear(BACKUP_ALARM);
      return;
    }
    if (existing && this.isCurrent(existing, schedule)) return;
    await alarms.create(BACKUP_ALARM, {
      periodInMinutes: schedule.intervalMinutes,
      delayInMinutes: schedule.intervalMinutes,
    });
  }

  /** One alarm tick: keep the alarm honest, then write a backup or record why not. */
  async runScheduled(schedule: BackupSchedule, pro: ProStatus): Promise<ScheduledRun> {
    const at = this.deps.clock();
    await this.ensureScheduled(schedule, pro);
    return { at, outcome: await this.tick(schedule, pro) };
  }

  async runNow(retention: number): Promise<BackupMeta> {
    const data = createExport(this.deps.getTree(), this.deps.clock());
    const record: BackupRecord = { ts: data.exportedAt, nodeCount: data.nodeCount, data };
    await this.deps.backups.put(record);
    await trimBackups(this.deps.backups, retention);
    return { ts: record.ts, nodeCount: record.nodeCount };
  }

  private async tick(schedule: BackupSchedule, pro: ProStatus): Promise<ScheduledOutcome> {
    if (!schedule.enabled) return { kind: "skipped", reason: "disabled" };
    if (pro !== "pro") return { kind: "skipped", reason: skipReason(pro) };
    try {
      const meta = await this.runNow(schedule.retention);
      return { kind: "written", nodeCount: meta.nodeCount };
    } catch (e) {
      return { kind: "failed", error: errorMessage(e) };
    }
  }

  /**
   * Same period, and the next fire no further out than one period. Chrome schedules alarms on
   * the wall clock, so a clock set backwards leaves the next fire stranded in the future.
   */
  private isCurrent(existing: AlarmInfo, schedule: BackupSchedule): boolean {
    if (existing.periodInMinutes !== schedule.intervalMinutes) return false;
    if (existing.scheduledTime === undefined) return true;
    const horizon = this.deps.clock() + schedule.intervalMinutes * 60_000 + SCHEDULE_TOLERANCE_MS;
    return existing.scheduledTime <= horizon;
  }
}

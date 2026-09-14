import type { Logger } from "@browserforge/shared";
import type { CleanupTrigger, Settings } from "../settings.js";

/** Session-scoped key/value storage that survives service-worker restarts. */
export interface SessionStore {
  get<T>(key: string): Promise<T | undefined>;
  /** `undefined` removes the key. */
  set(key: string, value: unknown): Promise<void>;
}

/** The slice of `chrome.alarms` the scheduler uses. */
export interface AlarmsPort {
  /** Creating an alarm with the same name replaces it. */
  create(name: string, delayInMinutes: number): Promise<void>;
  exists(name: string): Promise<boolean>;
}

export const CLEANUP_ALARM = "cookiesweep:cleanup";
export const PENDING_TRIGGER_KEY = "cookiesweep:pendingTrigger";
/** Production alarms are clamped to 30 s; shorter delays use setTimeout in the worker. */
export const ALARM_MIN_SECONDS = 30;

const TRIGGER_PRIORITY: Record<CleanupTrigger, number> = {
  "tab-close": 1,
  "domain-change": 1,
  manual: 2,
  startup: 3,
};

/** When triggers coalesce, the one with the widest scope wins (startup > manual > tab events). */
export function higherPriorityTrigger(
  current: CleanupTrigger | undefined,
  incoming: CleanupTrigger,
): CleanupTrigger {
  if (!current || TRIGGER_PRIORITY[incoming] > TRIGGER_PRIORITY[current]) return incoming;
  return current;
}

export interface SchedulerDeps {
  session: SessionStore;
  alarms: AlarmsPort;
  loadSettings(): Promise<Settings>;
  runCleanup(trigger: CleanupTrigger): Promise<unknown>;
  logger: Logger;
}

export interface CleanupScheduler {
  /** Queues a cleanup for `trigger` after the configured delay (no-op while paused). */
  schedule(trigger: CleanupTrigger): Promise<void>;
  /** Runs the pending cleanup now; concurrent calls collapse into one follow-up run. */
  runPending(): Promise<void>;
  /** A fresh worker re-arms a short-delay cleanup the previous worker owed. */
  resumePending(): Promise<void>;
}

export function createCleanupScheduler(deps: SchedulerDeps): CleanupScheduler {
  let shortTimer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  let queued = false;

  async function mergePendingTrigger(trigger: CleanupTrigger): Promise<void> {
    const current = await deps.session.get<CleanupTrigger>(PENDING_TRIGGER_KEY);
    const merged = higherPriorityTrigger(current, trigger);
    if (merged !== current) await deps.session.set(PENDING_TRIGGER_KEY, merged);
  }

  async function takePendingTrigger(): Promise<CleanupTrigger> {
    const trigger = (await deps.session.get<CleanupTrigger>(PENDING_TRIGGER_KEY)) ?? "tab-close";
    await deps.session.set(PENDING_TRIGGER_KEY, undefined);
    return trigger;
  }

  /**
   * Cleanups never overlap: a run snapshots tabs and cookies and then deletes, so two concurrent
   * runs (a window closing several tabs with delaySeconds 0) would each "remove" the same
   * cookies, Chrome echoing success for cookies that are already gone, and both would be logged.
   * Triggers that arrive while a run is in progress collapse into exactly one follow-up run,
   * which sees any tab that closed after the first snapshot.
   */
  function runPending(): Promise<void> {
    if (queued) return chain;
    queued = true;
    chain = chain.then(async () => {
      queued = false;
      const trigger = await takePendingTrigger();
      try {
        await deps.runCleanup(trigger);
      } catch (error) {
        deps.logger.error("cleanup failed", error);
      }
    });
    return chain;
  }

  function armShortTimer(delaySeconds: number): void {
    // Alarms are clamped to 30 s in production builds; use a worker timer and accept
    // that it can be lost if the service worker is suspended first (see resumePending).
    if (shortTimer) clearTimeout(shortTimer);
    shortTimer = setTimeout(() => {
      shortTimer = undefined;
      void runPending();
    }, delaySeconds * 1000);
  }

  async function schedule(trigger: CleanupTrigger): Promise<void> {
    const settings = await deps.loadSettings();
    if (!settings.enabled) return;
    await mergePendingTrigger(trigger);

    const delay = settings.delaySeconds;
    if (delay <= 0) {
      await runPending();
    } else if (delay < ALARM_MIN_SECONDS) {
      armShortTimer(delay);
    } else {
      // Re-creating an alarm with the same name replaces it, so bursts of triggers coalesce.
      await deps.alarms.create(CLEANUP_ALARM, delay / 60);
    }
  }

  /**
   * A worker can die with a sub-30 s `setTimeout` still pending. The trigger it was going to
   * serve is in session storage, so a fresh worker re-arms it (an alarm that is still
   * registered will fire on its own and needs no help).
   */
  async function resumePending(): Promise<void> {
    const pending = await deps.session.get<CleanupTrigger>(PENDING_TRIGGER_KEY);
    if (!pending) return;
    if (await deps.alarms.exists(CLEANUP_ALARM)) return;
    await schedule(pending);
  }

  return { schedule, runPending, resumePending };
}

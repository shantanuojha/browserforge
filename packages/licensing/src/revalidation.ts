import type { AlarmsLike, LicenseClient, ScheduleRevalidationOptions } from "./types.js";

export const DEFAULT_REVALIDATE_EVERY_MS = 7 * 24 * 3600 * 1000;

const MIN_ALARM_PERIOD_MINUTES = 1;

/**
 * Registers a periodic `chrome.alarms` alarm named `${productName}:license-revalidate` and a
 * handler that force-revalidates when it fires. Call once from the background entrypoint.
 * Returns a function that removes the listener and clears the alarm.
 *
 * The background script re-runs on every service-worker start, so the alarm is only created
 * when it does not already exist with the right period: re-creating it would reschedule the
 * first fire and force a licence-server round-trip after every wake-up.
 */
export function scheduleRevalidation(
  alarms: AlarmsLike,
  client: LicenseClient,
  options: ScheduleRevalidationOptions & { revalidateEveryMs?: number } = {},
): () => void {
  const name = client.alarmName;
  const everyMs = options.revalidateEveryMs ?? DEFAULT_REVALIDATE_EVERY_MS;
  const periodInMinutes = Math.max(MIN_ALARM_PERIOD_MINUTES, Math.round(everyMs / 60_000));
  const handler = (alarm: { name: string }) => {
    if (alarm.name !== name) return;
    void client.validate({ force: true }).catch(() => undefined);
  };

  alarms.onAlarm.addListener(handler);
  void ensureAlarm(alarms, name, periodInMinutes);
  if (options.validateOnStart ?? true) {
    void client.validate().catch(() => undefined);
  }

  return () => {
    alarms.onAlarm.removeListener(handler);
    void Promise.resolve(alarms.clear?.(name)).catch(() => undefined);
  };
}

async function ensureAlarm(alarms: AlarmsLike, name: string, periodInMinutes: number) {
  try {
    const existing = alarms.get ? await alarms.get(name) : undefined;
    if (existing && existing.periodInMinutes === periodInMinutes) return;
    // First fire one full period out: `validateOnStart` already covers a stale cache now.
    await alarms.create(name, { periodInMinutes, delayInMinutes: periodInMinutes });
  } catch {
    // Alarms unavailable in this context; the cheap validate() on start still runs.
  }
}

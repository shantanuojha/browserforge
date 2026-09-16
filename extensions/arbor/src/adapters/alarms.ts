import { browser } from "wxt/browser";
import type { AlarmsPort } from "../lib/background/ports";

export const browserAlarms: AlarmsPort = {
  async create(name, { periodInMinutes, delayInMinutes }) {
    // `AlarmCreateInfo` wants at least one timing field, so pass exactly the ones given.
    if (delayInMinutes !== undefined && periodInMinutes !== undefined) {
      await browser.alarms.create(name, { delayInMinutes, periodInMinutes });
    } else if (delayInMinutes !== undefined) {
      await browser.alarms.create(name, { delayInMinutes });
    } else if (periodInMinutes !== undefined) {
      await browser.alarms.create(name, { periodInMinutes });
    }
  },
  async get(name) {
    const alarm = await browser.alarms.get(name);
    return alarm
      ? { periodInMinutes: alarm.periodInMinutes, scheduledTime: alarm.scheduledTime }
      : undefined;
  },
  async clear(name) {
    await browser.alarms.clear(name);
  },
  onAlarm(listener) {
    browser.alarms.onAlarm.addListener((alarm) => listener(alarm.name));
  },
};

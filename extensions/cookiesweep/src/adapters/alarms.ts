import { browser } from "wxt/browser";
import type { AlarmsPort } from "../lib/background/scheduler.js";

export const browserAlarms: AlarmsPort = {
  async create(name, delayInMinutes) {
    await browser.alarms.create(name, { delayInMinutes });
  },
  async exists(name) {
    const alarm = await browser.alarms.get(name).catch(() => undefined);
    return alarm !== undefined;
  },
};

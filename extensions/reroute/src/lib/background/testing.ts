/** In-memory ports for the background services. Test-only. */
import type { DnrRule } from "../dnr";
import type { LogEntry } from "../log";
import type { ActivityLogStore, ActivityRecorder } from "./activity-recorder";
import type { ContentScriptMessenger } from "./copy-clean-link";
import type { RedirectTabsPort } from "./redirect-fallback";
import type { DnrPort } from "./rule-deployer";

export function createMemoryLogStore(): ActivityLogStore & { entries: LogEntry[] } {
  const store = {
    entries: [] as LogEntry[],
    async getValue() {
      return [...store.entries];
    },
    async setValue(entries: LogEntry[]) {
      store.entries = [...entries];
    },
    watch() {
      return () => undefined;
    },
  };
  return store;
}

/** Records events in memory; `errors` is a shortcut to the error details. */
export function createRecordingRecorder(): ActivityRecorder & { events: Omit<LogEntry, "at">[] } {
  const events: Omit<LogEntry, "at">[] = [];
  return {
    events,
    async record(event) {
      events.push(event);
    },
    async recordError(detail, context = {}) {
      events.push({ kind: "error", from: "", ...context, detail });
    },
  };
}

export interface FakeDnr extends DnrPort {
  rules: DnrRule[];
  enabledRulesets: string[];
  /** Regex sources the "engine" rejects. */
  unsupportedRegexes: Set<string>;
  /** Dynamic rule ids `updateDynamicRules` throws for. */
  rejectedIds: Set<number>;
}

export function createFakeDnr(): FakeDnr {
  const dnr: FakeDnr = {
    rules: [],
    enabledRulesets: ["tracking-params"],
    unsupportedRegexes: new Set(),
    rejectedIds: new Set(),
    async getDynamicRules() {
      return [...dnr.rules];
    },
    async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
      const rejected = addRules.find((r) => dnr.rejectedIds.has(r.id));
      if (rejected) throw new Error(`rule ${rejected.id} is invalid`);
      const remove = new Set(removeRuleIds);
      dnr.rules = [...dnr.rules.filter((r) => !remove.has(r.id)), ...addRules];
    },
    async isRegexSupported({ regex }) {
      return { isSupported: !dnr.unsupportedRegexes.has(regex) };
    },
    async getEnabledRulesets() {
      return [...dnr.enabledRulesets];
    },
    async updateEnabledRulesets({ enableRulesetIds = [], disableRulesetIds = [] }) {
      const off = new Set(disableRulesetIds);
      dnr.enabledRulesets = [
        ...dnr.enabledRulesets.filter((id) => !off.has(id)),
        ...enableRulesetIds,
      ];
    },
  };
  return dnr;
}

export function createFakeTabs(): RedirectTabsPort &
  ContentScriptMessenger & {
    updates: { tabId: number; url: string }[];
    sent: unknown[];
    failUpdate: boolean;
  } {
  const tabs = {
    updates: [] as { tabId: number; url: string }[],
    sent: [] as unknown[],
    failUpdate: false,
    async update(tabId: number, url: string) {
      if (tabs.failUpdate) throw new Error("No tab with id");
      tabs.updates.push({ tabId, url });
    },
    async sendToTab(tabId: number, message: unknown) {
      tabs.sent.push({ tabId, message });
    },
  };
  return tabs;
}

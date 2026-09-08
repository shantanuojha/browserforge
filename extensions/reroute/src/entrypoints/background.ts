import { hostMatchesAny } from "@browserforge/shared";
import { browser, type Browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import type { DnrRule } from "../lib/dnr";
import { DNR_ID_RANGE } from "../lib/dnr";
import { setupLicensing } from "../lib/licensing";
import { appendLog, type LogEntry } from "../lib/log";
import { isMessage, type Message, type StatusResponse } from "../lib/messages";
import { isPro } from "../lib/pro";
import {
  allowlistToDNR,
  appliesToNavigation,
  compileToDNR,
  firstMatch,
  wouldLoop,
} from "../lib/rules/engine";
import type { Rule } from "../lib/rules/model";
import {
  allowlistItem,
  getSettings,
  logItem,
  rulesItem,
  settingsItem,
  type Settings,
} from "../lib/storage";
import { newOrigin, readRulesFromSync, writeRulesToSync } from "../lib/sync";
import { cleanUrl } from "../lib/tracking/clean";
import { loadTrackingRules } from "../lib/tracking/load";

const TRACKING_RULESET_ID = "tracking-params";
const MENU_COPY_CLEAN = "reroute-copy-clean-link";
/** Redirect history per tab is forgotten after this window. */
const LOOP_WINDOW_MS = 10_000;

interface State {
  rules: Rule[];
  enabledRules: Rule[];
  allowlist: string[];
  settings: Settings;
  /** Rules the JS fallback must handle on onBeforeNavigate (everything is JS on history-state). */
  jsOnlyRuleIds: Set<string>;
  jsOnlyReasons: Record<string, string>;
  dnrRuleCount: number;
  lastError: string | null;
  lastRebuildAt: number;
}

export default defineBackground(() => {
  const state: State = {
    rules: [],
    enabledRules: [],
    allowlist: [],
    settings: { trackingEnabled: true, syncEnabled: false },
    jsOnlyRuleIds: new Set(),
    jsOnlyReasons: {},
    dnrRuleCount: 0,
    lastError: null,
    lastRebuildAt: 0,
  };
  const tabHistory = new Map<number, { at: number; url: string }[]>();
  let log: LogEntry[] = [];
  let logLoaded = false;
  const syncOrigin = newOrigin();
  let lastSyncWrite = 0;
  /** Serialised rules last written to or applied from sync; prevents echo loops. */
  let lastSyncedText: string | null = null;
  let syncTimer: ReturnType<typeof setTimeout> | null = null;

  // -------------------------------------------------------------------------
  // Licensing
  // -------------------------------------------------------------------------

  // Creates the Lemon Squeezy client (when this build is configured) and keeps the stored licence
  // fresh: a cheap validate() now, a forced one on the periodic alarm. Offline stays Pro for the
  // grace period. `isPro()` below reads the cached state, so nothing else needs to change.
  setupLicensing()?.scheduleRevalidation(browser.alarms);

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  async function record(entry: Omit<LogEntry, "at">): Promise<void> {
    if (!logLoaded) {
      log = await logItem.getValue();
      logLoaded = true;
    }
    log = appendLog(log, { at: Date.now(), ...entry });
    try {
      await logItem.setValue(log);
    } catch {
      // storage quota or transient failure; the in-memory log still has it
    }
  }

  // -------------------------------------------------------------------------
  // DNR management
  // -------------------------------------------------------------------------

  async function regexSupported(rule: DnrRule): Promise<boolean> {
    const regex = rule.condition.regexFilter;
    if (!regex) return true;
    const api = browser.declarativeNetRequest;
    if (typeof api.isRegexSupported !== "function") return true;
    try {
      const res = await api.isRegexSupported({
        regex,
        isCaseSensitive: false,
        requireCapturing: rule.action.type === "redirect",
      });
      return res.isSupported;
    } catch {
      return true; // let updateDynamicRules be the judge
    }
  }

  /** Replaces all dynamic rules. Returns ids that the browser rejected. */
  async function replaceDynamicRules(desired: DnrRule[]): Promise<Set<number>> {
    const api = browser.declarativeNetRequest;
    const existing = await api.getDynamicRules();
    const removeRuleIds = existing.map((r) => r.id);
    const addRules = desired as Browser.declarativeNetRequest.Rule[];
    try {
      await api.updateDynamicRules({ removeRuleIds, addRules });
      return new Set();
    } catch (err) {
      // Something in the batch is invalid: clear, then add one at a time.
      await api.updateDynamicRules({ removeRuleIds });
      const failed = new Set<number>();
      for (const rule of addRules) {
        try {
          await api.updateDynamicRules({ addRules: [rule] });
        } catch (e) {
          failed.add(rule.id);
          await record({
            kind: "error",
            from: rule.condition.regexFilter ?? "",
            detail: `Dynamic rule ${rule.id} rejected: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
      if (failed.size === 0) {
        await record({
          kind: "error",
          from: "",
          detail: `Batch update failed but rules applied individually: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
      return failed;
    }
  }

  async function applyTrackingToggle(enabled: boolean): Promise<void> {
    const api = browser.declarativeNetRequest;
    try {
      const current = await api.getEnabledRulesets();
      const isOn = current.includes(TRACKING_RULESET_ID);
      if (enabled && !isOn)
        await api.updateEnabledRulesets({ enableRulesetIds: [TRACKING_RULESET_ID] });
      if (!enabled && isOn)
        await api.updateEnabledRulesets({ disableRulesetIds: [TRACKING_RULESET_ID] });
    } catch (e) {
      state.lastError = `Tracking ruleset toggle failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  let rebuildChain: Promise<void> = Promise.resolve();

  /** Serialised: loads storage, compiles, pushes DNR, refreshes in-memory state. */
  function rebuild(): Promise<void> {
    rebuildChain = rebuildChain.then(doRebuild, doRebuild);
    return rebuildChain;
  }

  async function doRebuild(): Promise<void> {
    try {
      const [rules, allowlist, settings] = await Promise.all([
        rulesItem.getValue(),
        allowlistItem.getValue(),
        getSettings(),
      ]);
      state.rules = rules;
      state.enabledRules = rules.filter((r) => r.enabled);
      state.allowlist = allowlist;
      state.settings = settings;

      const compiled = compileToDNR(rules, DNR_ID_RANGE.userRuleBase);
      const jsOnly = new Set(compiled.jsOnlyRuleIds);
      const reasons = { ...compiled.jsOnlyReasons };
      const ruleIdByDnrId = new Map<number, string>();
      for (const [ruleId, dnrId] of Object.entries(compiled.dnrIdByRuleId)) {
        ruleIdByDnrId.set(dnrId, ruleId);
      }

      // Demote regexes the engine says it cannot handle (RE2 memory limit etc.).
      const accepted: DnrRule[] = [];
      for (const dnr of compiled.dnrRules) {
        if (await regexSupported(dnr)) {
          accepted.push(dnr);
        } else {
          const ruleId = ruleIdByDnrId.get(dnr.id);
          if (ruleId) {
            jsOnly.add(ruleId);
            reasons[ruleId] = "browser rejected the regex (isRegexSupported)";
          }
        }
      }

      const desired = [...allowlistToDNR(allowlist, DNR_ID_RANGE.siteAllowBase), ...accepted];
      const failed = await replaceDynamicRules(desired);
      for (const dnrId of failed) {
        const ruleId = ruleIdByDnrId.get(dnrId);
        if (ruleId) {
          jsOnly.add(ruleId);
          reasons[ruleId] = "browser rejected the dynamic rule";
        }
      }

      state.jsOnlyRuleIds = jsOnly;
      state.jsOnlyReasons = reasons;
      state.dnrRuleCount = desired.length - failed.size;
      state.lastError = null;
      state.lastRebuildAt = Date.now();

      await applyTrackingToggle(settings.trackingEnabled);
    } catch (e) {
      state.lastError = e instanceof Error ? e.message : String(e);
      await record({ kind: "error", from: "", detail: `Rebuild failed: ${state.lastError}` });
    }
  }

  const ready = rebuild();

  // -------------------------------------------------------------------------
  // JS fallback (webNavigation)
  // -------------------------------------------------------------------------

  function historyFor(tabId: number, now: number): string[] {
    const entries = (tabHistory.get(tabId) ?? []).filter((e) => now - e.at < LOOP_WINDOW_MS);
    tabHistory.set(tabId, entries);
    return entries.map((e) => e.url);
  }

  function isAllowlisted(url: string): boolean {
    if (state.allowlist.length === 0) return false;
    try {
      return hostMatchesAny(new URL(url).hostname, state.allowlist);
    } catch {
      return false;
    }
  }

  async function handleNavigation(
    tabId: number,
    url: string,
    source: "navigate" | "history",
  ): Promise<void> {
    if (tabId < 0 || !/^https?:/i.test(url)) return;
    await ready;
    if (state.enabledRules.length === 0 || isAllowlisted(url)) return;

    const candidates = state.enabledRules.filter(appliesToNavigation);
    const match = firstMatch(url, candidates);
    if (!match) return;

    // On a real navigation DNR already handled its rules; only act for JS-only ones.
    if (source === "navigate" && !state.jsOnlyRuleIds.has(match.rule.id)) return;

    const now = Date.now();
    const history = historyFor(tabId, now);
    if (wouldLoop(url, match.target, history)) {
      await record({
        kind: "loop",
        tabId,
        from: url,
        to: match.target,
        ruleId: match.rule.id,
        ruleName: match.rule.name,
        detail: "Redirect loop prevented",
      });
      return;
    }
    tabHistory.get(tabId)?.push({ at: now, url: match.target });

    try {
      await browser.tabs.update(tabId, { url: match.target });
      await record({
        kind: "js",
        tabId,
        from: url,
        to: match.target,
        ruleId: match.rule.id,
        ruleName: match.rule.name,
        detail: source === "history" ? "history-state" : "navigation",
      });
    } catch (e) {
      await record({
        kind: "error",
        tabId,
        from: url,
        to: match.target,
        ruleId: match.rule.id,
        detail: `tabs.update failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  browser.webNavigation.onBeforeNavigate.addListener((details) => {
    if (details.frameId !== 0) return;
    void handleNavigation(details.tabId, details.url, "navigate");
  });

  browser.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId !== 0) return;
    void handleNavigation(details.tabId, details.url, "history");
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    tabHistory.delete(tabId);
  });

  // -------------------------------------------------------------------------
  // Storage watchers
  // -------------------------------------------------------------------------

  rulesItem.watch(() => {
    void rebuild().then(() => scheduleSyncWrite());
  });
  allowlistItem.watch(() => void rebuild());
  settingsItem.watch(() => void rebuild().then(() => scheduleSyncWrite()));

  // -------------------------------------------------------------------------
  // Pro: sync mirroring
  // -------------------------------------------------------------------------

  function scheduleSyncWrite(): void {
    if (!state.settings.syncEnabled) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      void (async () => {
        if (!(await isPro())) return;
        const text = JSON.stringify(state.rules);
        if (text === lastSyncedText) return;
        try {
          const meta = await writeRulesToSync(state.rules, syncOrigin);
          lastSyncWrite = meta.updatedAt;
          lastSyncedText = text;
        } catch (e) {
          await record({
            kind: "error",
            from: "",
            detail: `Sync write failed: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      })();
    }, 1_500);
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !("reroute.sync.meta" in changes)) return;
    void (async () => {
      if (!state.settings.syncEnabled || !(await isPro())) return;
      const snap = await readRulesFromSync();
      if (!snap || snap.meta.origin === syncOrigin || snap.meta.updatedAt <= lastSyncWrite) return;
      lastSyncWrite = snap.meta.updatedAt;
      lastSyncedText = JSON.stringify(snap.rules);
      await rulesItem.setValue(snap.rules);
    })();
  });

  // -------------------------------------------------------------------------
  // Context menu: Copy clean link
  // -------------------------------------------------------------------------

  async function installContextMenu(): Promise<void> {
    try {
      await browser.contextMenus.removeAll();
      browser.contextMenus.create({
        id: MENU_COPY_CLEAN,
        title: "Copy clean link",
        contexts: ["link", "page"],
      });
    } catch {
      // Some browsers throw when the menu already exists; harmless.
    }
  }

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_COPY_CLEAN) return;
    const url = info.linkUrl ?? info.pageUrl;
    if (!url || tab?.id === undefined) return;
    void (async () => {
      const rules = state.settings.trackingEnabled ? await loadTrackingRules() : [];
      const cleaned = cleanUrl(url, rules);
      const message: Message = { type: "reroute:copy-text", text: cleaned.url };
      try {
        const options = info.frameId !== undefined ? { frameId: info.frameId } : undefined;
        await browser.tabs.sendMessage(tab.id as number, message, options);
      } catch {
        // Tab without our content script (browser page, or tab opened before install).
        await record({
          kind: "error",
          from: url,
          to: cleaned.url,
          detail: "Copy clean link: page cannot receive the clipboard message; reload the tab",
        });
      }
    })();
  });

  browser.runtime.onInstalled.addListener(() => {
    void installContextMenu();
    void rebuild();
  });
  browser.runtime.onStartup.addListener(() => {
    void installContextMenu();
    void rebuild();
  });

  // -------------------------------------------------------------------------
  // Messages from popup / options
  // -------------------------------------------------------------------------

  browser.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    if (!isMessage(raw)) return;
    if (raw.type === "reroute:get-status") {
      // Wait for the most recent rebuild so the UI sees the state after its own storage write.
      void rebuildChain.then(() => {
        const response: StatusResponse = {
          enabledRules: state.enabledRules.length,
          dnrRules: state.dnrRuleCount,
          jsOnlyRuleIds: [...state.jsOnlyRuleIds],
          jsOnlyReasons: state.jsOnlyReasons,
          trackingEnabled: state.settings.trackingEnabled,
          lastError: state.lastError,
          lastRebuildAt: state.lastRebuildAt,
        };
        sendResponse(response);
      });
      return true;
    }
    if (raw.type === "reroute:rebuild") {
      void rebuild().then(() => sendResponse({ ok: true }));
      return true;
    }
    return;
  });

  // -------------------------------------------------------------------------
  // Dev-only diagnostics (declarativeNetRequestFeedback)
  // -------------------------------------------------------------------------

  if (import.meta.env.DEV) {
    const debugEvent = browser.declarativeNetRequest.onRuleMatchedDebug;
    if (debugEvent && typeof debugEvent.addListener === "function") {
      debugEvent.addListener((info) => {
        const { rule, request } = info;
        void record({
          kind: "dnr",
          tabId: request.tabId,
          from: request.url,
          detail: `${rule.rulesetId} #${rule.ruleId}`,
        });
      });
    }
    void ready.then(async () => {
      // Surface static regexes the engine rejects so the catalog compiler can be tuned.
      const rules = await loadTrackingRules();
      for (const rule of rules) {
        if (rule.condition.regexFilter && !(await regexSupported(rule))) {
          console.warn("[reroute] static regex unsupported:", rule.id, rule.condition.regexFilter);
        }
      }
    });
  }
});

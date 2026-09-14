import { errorMessage, type Clock } from "@browserforge/shared";
import { isUrlAllowlisted } from "../rules/allowlist";
import { appliesToNavigation, firstMatch, wouldLoop, type FirstMatch } from "../rules/engine";
import type { Rule } from "../rules/model";
import type { ActivityRecorder } from "./activity-recorder";

/** The one thing the fallback does to a tab. */
export interface RedirectTabsPort {
  update(tabId: number, url: string): Promise<void>;
}

export type NavigationSource = "navigate" | "history";

/** What the fallback reads from the background state on every navigation. */
export interface FallbackView {
  enabledRules: readonly Rule[];
  allowlist: readonly string[];
  jsOnlyRuleIds: ReadonlySet<string>;
}

export interface RedirectFallback {
  handleNavigation(tabId: number, url: string, source: NavigationSource): Promise<void>;
  forgetTab(tabId: number): void;
}

/** Redirect history per tab is forgotten after this window. */
export const LOOP_WINDOW_MS = 10_000;

/** Recent redirect targets per tab, so `wouldLoop` can spot a bounce. */
export class TabRedirectHistory {
  private readonly byTab = new Map<number, { at: number; url: string }[]>();

  constructor(private readonly windowMs = LOOP_WINDOW_MS) {}

  /** Targets still inside the window (oldest first); prunes the rest. */
  recent(tabId: number, now: number): string[] {
    const entries = (this.byTab.get(tabId) ?? []).filter((e) => now - e.at < this.windowMs);
    this.byTab.set(tabId, entries);
    return entries.map((e) => e.url);
  }

  remember(tabId: number, url: string, now: number): void {
    const entries = this.byTab.get(tabId) ?? [];
    entries.push({ at: now, url });
    this.byTab.set(tabId, entries);
  }

  forget(tabId: number): void {
    this.byTab.delete(tabId);
  }
}

export interface RedirectFallbackDeps {
  tabs: RedirectTabsPort;
  recorder: ActivityRecorder;
  clock: Clock;
  view(): FallbackView;
  /** Resolves once the first rebuild has populated the view. */
  ready: Promise<unknown>;
  history?: TabRedirectHistory;
}

const isHttpUrl = (url: string): boolean => /^https?:/i.test(url);

/**
 * The JavaScript half of redirecting: rules DNR cannot express (transforms, excludes, non-RE2
 * regexes) on top-level navigations, and every rule on history-state (SPA) navigations, which
 * DNR never sees.
 */
export function createRedirectFallback(deps: RedirectFallbackDeps): RedirectFallback {
  const history = deps.history ?? new TabRedirectHistory();

  function findMatch(url: string, source: NavigationSource): FirstMatch | null {
    const view = deps.view();
    if (view.enabledRules.length === 0 || isUrlAllowlisted(url, view.allowlist)) return null;
    const match = firstMatch(url, view.enabledRules.filter(appliesToNavigation));
    if (!match) return null;
    // On a real navigation DNR already handled its rules; only act for JS-only ones.
    if (source === "navigate" && !view.jsOnlyRuleIds.has(match.rule.id)) return null;
    return match;
  }

  async function redirect(tabId: number, url: string, match: FirstMatch, source: NavigationSource) {
    const context = { tabId, from: url, to: match.target, ruleId: match.rule.id };
    try {
      await deps.tabs.update(tabId, match.target);
      await deps.recorder.record({
        kind: "js",
        ...context,
        ruleName: match.rule.name,
        detail: source === "history" ? "history-state" : "navigation",
      });
    } catch (e) {
      await deps.recorder.recordError(`tabs.update failed: ${errorMessage(e)}`, context);
    }
  }

  async function handleNavigation(tabId: number, url: string, source: NavigationSource) {
    if (tabId < 0 || !isHttpUrl(url)) return;
    await deps.ready;
    const match = findMatch(url, source);
    if (!match) return;

    const now = deps.clock();
    if (wouldLoop(url, match.target, history.recent(tabId, now))) {
      await deps.recorder.record({
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
    history.remember(tabId, match.target, now);
    await redirect(tabId, url, match, source);
  }

  return { handleNavigation, forgetTab: (tabId) => history.forget(tabId) };
}

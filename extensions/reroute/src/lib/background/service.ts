/**
 * Composes the background services and owns the rebuild cycle: load storage, compile, deploy to
 * DNR, refresh the in-memory state. Everything the browser provides arrives through ports, so
 * the whole orchestration runs in unit tests with in-memory fakes.
 */

import { errorMessage, type Clock } from "@browserforge/shared";
import type { DnrRule } from "../dnr";
import type { StatusResponse } from "../messages";
import type { Rule } from "../rules/model";
import { syncJustEnabled, withSettingsDefaults, type Settings } from "../settings";
import type { SyncStore } from "../sync/store";
import {
  createActivityRecorder,
  type ActivityLogStore,
  type ActivityRecorder,
} from "./activity-recorder";
import {
  createCopyCleanLink,
  type ContentScriptMessenger,
  type CopyCleanLinkRequest,
} from "./copy-clean-link";
import {
  createRedirectFallback,
  type RedirectFallback,
  type RedirectTabsPort,
} from "./redirect-fallback";
import { createRuleDeployer, type DnrPort, type RuleDeployer } from "./rule-deployer";
import { initialState, toStatusResponse, type BackgroundState } from "./state";
import { createSyncMirror, type SyncMirror } from "./sync-mirror";

/** A typed storage slot; `WxtStorageItem<T>` satisfies it. */
export interface ValueStore<T> {
  getValue(): Promise<T>;
  setValue(value: T): Promise<void>;
}

export interface BackgroundDeps {
  dnr: DnrPort;
  tabs: RedirectTabsPort & ContentScriptMessenger;
  rulesStore: ValueStore<Rule[]>;
  allowlistStore: ValueStore<string[]>;
  settingsStore: ValueStore<Partial<Settings> | null>;
  logStore: ActivityLogStore;
  syncStore: SyncStore;
  syncOrigin: string;
  isPro(): Promise<boolean>;
  loadTrackingRules(): Promise<DnrRule[]>;
  clock: Clock;
}

export interface BackgroundService {
  /** Serialised: loads storage, compiles, pushes DNR, refreshes in-memory state. */
  rebuild(): Promise<void>;
  /** Resolves after the most recent rebuild, so callers see the state after their own write. */
  whenIdle(): Promise<void>;
  getStatus(): Promise<StatusResponse>;
  readonly state: Readonly<BackgroundState>;
  readonly fallback: RedirectFallback;
  readonly mirror: SyncMirror;
  readonly deployer: RuleDeployer;
  readonly recorder: ActivityRecorder;
  copyCleanLink(request: CopyCleanLinkRequest): Promise<void>;
  onRulesChanged(): Promise<void>;
  onAllowlistChanged(): Promise<void>;
  onSettingsChanged(next: Settings | null, previous: Settings | null): Promise<void>;
}

class RerouteBackground implements BackgroundService {
  readonly state: BackgroundState = initialState();
  readonly recorder: ActivityRecorder;
  readonly deployer: RuleDeployer;
  readonly fallback: RedirectFallback;
  readonly mirror: SyncMirror;
  readonly copyCleanLink: (request: CopyCleanLinkRequest) => Promise<void>;

  private rebuildChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: BackgroundDeps) {
    this.recorder = createActivityRecorder(deps.logStore, deps.clock);
    this.deployer = createRuleDeployer(deps.dnr, this.recorder);
    const ready = this.rebuild();
    this.fallback = createRedirectFallback({
      tabs: deps.tabs,
      recorder: this.recorder,
      clock: deps.clock,
      ready,
      view: () => this.state,
    });
    this.mirror = createSyncMirror({
      store: deps.syncStore,
      isPro: deps.isPro,
      saveLocalRules: (rules) => deps.rulesStore.setValue(rules),
      recorder: this.recorder,
      origin: deps.syncOrigin,
      view: () => ({ rules: this.state.rules, syncEnabled: this.state.settings.syncEnabled }),
    });
    this.copyCleanLink = createCopyCleanLink({
      messenger: deps.tabs,
      recorder: this.recorder,
      loadTrackingRules: deps.loadTrackingRules,
      isTrackingEnabled: () => this.state.settings.trackingEnabled,
    });
  }

  rebuild(): Promise<void> {
    const run = () => this.doRebuild();
    this.rebuildChain = this.rebuildChain.then(run, run);
    return this.rebuildChain;
  }

  whenIdle(): Promise<void> {
    return this.rebuildChain;
  }

  async getStatus(): Promise<StatusResponse> {
    await this.rebuildChain;
    return toStatusResponse(this.state);
  }

  async onRulesChanged(): Promise<void> {
    await this.rebuild();
    this.mirror.scheduleWrite();
  }

  onAllowlistChanged(): Promise<void> {
    return this.rebuild();
  }

  async onSettingsChanged(next: Settings | null, previous: Settings | null): Promise<void> {
    await this.rebuild();
    if (syncJustEnabled(next, previous)) await this.mirror.join();
    else this.mirror.scheduleWrite();
  }

  private async loadState(): Promise<void> {
    const [rules, allowlist, settings] = await Promise.all([
      this.deps.rulesStore.getValue(),
      this.deps.allowlistStore.getValue(),
      this.deps.settingsStore.getValue(),
    ]);
    this.state.rules = rules;
    this.state.enabledRules = rules.filter((r) => r.enabled);
    this.state.allowlist = allowlist;
    this.state.settings = withSettingsDefaults(settings);
  }

  private async applyTrackingToggle(): Promise<void> {
    try {
      await this.deployer.setTrackingEnabled(this.state.settings.trackingEnabled);
    } catch (e) {
      this.state.lastError = `Tracking ruleset toggle failed: ${errorMessage(e)}`;
    }
  }

  private async doRebuild(): Promise<void> {
    try {
      await this.loadState();
      const deployment = await this.deployer.deploy(this.state.rules, this.state.allowlist);
      this.state.jsOnlyRuleIds = deployment.jsOnlyRuleIds;
      this.state.jsOnlyReasons = deployment.jsOnlyReasons;
      this.state.dnrRuleCount = deployment.dnrRuleCount;
      this.state.lastError = null;
      this.state.lastRebuildAt = this.deps.clock();
      await this.applyTrackingToggle();
    } catch (e) {
      this.state.lastError = errorMessage(e);
      await this.recorder.recordError(`Rebuild failed: ${this.state.lastError}`);
    }
  }
}

export function createBackgroundService(deps: BackgroundDeps): BackgroundService {
  return new RerouteBackground(deps);
}

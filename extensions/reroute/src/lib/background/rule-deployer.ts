import { errorMessage } from "@browserforge/shared";
import { DNR_ID_RANGE, type DnrRule } from "../dnr";
import { allowlistToDNR, compileToDNR } from "../rules/dnr-compiler";
import type { Rule } from "../rules/model";
import type { ActivityRecorder } from "./activity-recorder";

/** The slice of `declarativeNetRequest` the deployer uses. */
export interface DnrPort {
  getDynamicRules(): Promise<readonly { id: number }[]>;
  updateDynamicRules(options: { removeRuleIds?: number[]; addRules?: DnrRule[] }): Promise<void>;
  /** Absent on browsers without the API; every regex is then assumed supported. */
  isRegexSupported?(options: {
    regex: string;
    isCaseSensitive: boolean;
    requireCapturing: boolean;
  }): Promise<{ isSupported: boolean }>;
  getEnabledRulesets(): Promise<string[]>;
  updateEnabledRulesets(options: {
    enableRulesetIds?: string[];
    disableRulesetIds?: string[];
  }): Promise<void>;
}

export const TRACKING_RULESET_ID = "tracking-params";

export interface Deployment {
  jsOnlyRuleIds: Set<string>;
  jsOnlyReasons: Record<string, string>;
  /** User redirect rules the browser accepted; the allowlist allow rules are not counted. */
  dnrRuleCount: number;
}

export interface RuleDeployer {
  /** Replaces every dynamic rule with the compiled user rules and allowlist. */
  deploy(rules: readonly Rule[], allowlist: readonly string[]): Promise<Deployment>;
  /** Enables or disables the static tracking-parameter ruleset. Throws on failure. */
  setTrackingEnabled(enabled: boolean): Promise<void>;
  /** Whether the browser's regex engine accepts a rule's `regexFilter`. Unknown means yes. */
  isRegexSupported(rule: DnrRule): Promise<boolean>;
}

/** Bookkeeping for rules that fall back to JavaScript during one deployment. */
class Demotions {
  readonly jsOnlyRuleIds: Set<string>;
  readonly jsOnlyReasons: Record<string, string>;
  private readonly ruleIdByDnrId: Map<number, string>;

  constructor(compiled: ReturnType<typeof compileToDNR>) {
    this.jsOnlyRuleIds = new Set(compiled.jsOnlyRuleIds);
    this.jsOnlyReasons = { ...compiled.jsOnlyReasons };
    this.ruleIdByDnrId = new Map(
      Object.entries(compiled.dnrIdByRuleId).map(([ruleId, dnrId]) => [dnrId, ruleId]),
    );
  }

  demote(dnrId: number, reason: string): void {
    const ruleId = this.ruleIdByDnrId.get(dnrId);
    if (!ruleId) return;
    this.jsOnlyRuleIds.add(ruleId);
    this.jsOnlyReasons[ruleId] = reason;
  }
}

class DnrRuleDeployer implements RuleDeployer {
  constructor(
    private readonly dnr: DnrPort,
    private readonly recorder: ActivityRecorder,
  ) {}

  async isRegexSupported(rule: DnrRule): Promise<boolean> {
    const regex = rule.condition.regexFilter;
    if (!regex || !this.dnr.isRegexSupported) return true;
    try {
      const res = await this.dnr.isRegexSupported({
        regex,
        isCaseSensitive: false,
        requireCapturing: rule.action.type === "redirect",
      });
      return res.isSupported;
    } catch {
      return true; // let updateDynamicRules be the judge
    }
  }

  async deploy(rules: readonly Rule[], allowlist: readonly string[]): Promise<Deployment> {
    const compiled = compileToDNR(rules, DNR_ID_RANGE.userRuleBase);
    const demotions = new Demotions(compiled);

    // Demote regexes the engine says it cannot handle (RE2 memory limit etc.).
    const accepted: DnrRule[] = [];
    for (const rule of compiled.dnrRules) {
      if (await this.isRegexSupported(rule)) accepted.push(rule);
      else demotions.demote(rule.id, "browser rejected the regex (isRegexSupported)");
    }

    const desired = [...allowlistToDNR(allowlist, DNR_ID_RANGE.siteAllowBase), ...accepted];
    const failed = await this.replaceDynamicRules(desired);
    for (const dnrId of failed) demotions.demote(dnrId, "browser rejected the dynamic rule");

    return {
      jsOnlyRuleIds: demotions.jsOnlyRuleIds,
      jsOnlyReasons: demotions.jsOnlyReasons,
      dnrRuleCount: accepted.filter((r) => !failed.has(r.id)).length,
    };
  }

  async setTrackingEnabled(enabled: boolean): Promise<void> {
    const current = await this.dnr.getEnabledRulesets();
    const isOn = current.includes(TRACKING_RULESET_ID);
    if (enabled && !isOn) {
      await this.dnr.updateEnabledRulesets({ enableRulesetIds: [TRACKING_RULESET_ID] });
    }
    if (!enabled && isOn) {
      await this.dnr.updateEnabledRulesets({ disableRulesetIds: [TRACKING_RULESET_ID] });
    }
  }

  /** Replaces all dynamic rules. Returns ids that the browser rejected. */
  private async replaceDynamicRules(desired: readonly DnrRule[]): Promise<Set<number>> {
    const existing = await this.dnr.getDynamicRules();
    const removeRuleIds = existing.map((r) => r.id);
    try {
      await this.dnr.updateDynamicRules({ removeRuleIds, addRules: [...desired] });
      return new Set();
    } catch (batchError) {
      await this.dnr.updateDynamicRules({ removeRuleIds });
      const failed = await this.addIndividually(desired);
      if (failed.size === 0) {
        await this.recorder.recordError(
          `Batch update failed but rules applied individually: ${errorMessage(batchError)}`,
        );
      }
      return failed;
    }
  }

  /** Something in the batch is invalid: add one at a time and report the ids that fail. */
  private async addIndividually(rules: readonly DnrRule[]): Promise<Set<number>> {
    const failed = new Set<number>();
    for (const rule of rules) {
      try {
        await this.dnr.updateDynamicRules({ addRules: [rule] });
      } catch (e) {
        failed.add(rule.id);
        await this.recorder.recordError(`Dynamic rule ${rule.id} rejected: ${errorMessage(e)}`, {
          from: rule.condition.regexFilter ?? "",
        });
      }
    }
    return failed;
  }
}

export function createRuleDeployer(dnr: DnrPort, recorder: ActivityRecorder): RuleDeployer {
  return new DnrRuleDeployer(dnr, recorder);
}

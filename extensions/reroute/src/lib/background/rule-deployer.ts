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

export function createRuleDeployer(dnr: DnrPort, recorder: ActivityRecorder): RuleDeployer {
  async function isRegexSupported(rule: DnrRule): Promise<boolean> {
    const regex = rule.condition.regexFilter;
    if (!regex || !dnr.isRegexSupported) return true;
    try {
      const res = await dnr.isRegexSupported({
        regex,
        isCaseSensitive: false,
        requireCapturing: rule.action.type === "redirect",
      });
      return res.isSupported;
    } catch {
      return true; // let updateDynamicRules be the judge
    }
  }

  /** Something in the batch is invalid: add one at a time and report the ids that fail. */
  async function addIndividually(rules: readonly DnrRule[]): Promise<Set<number>> {
    const failed = new Set<number>();
    for (const rule of rules) {
      try {
        await dnr.updateDynamicRules({ addRules: [rule] });
      } catch (e) {
        failed.add(rule.id);
        await recorder.recordError(`Dynamic rule ${rule.id} rejected: ${errorMessage(e)}`, {
          from: rule.condition.regexFilter ?? "",
        });
      }
    }
    return failed;
  }

  /** Replaces all dynamic rules. Returns ids that the browser rejected. */
  async function replaceDynamicRules(desired: readonly DnrRule[]): Promise<Set<number>> {
    const existing = await dnr.getDynamicRules();
    const removeRuleIds = existing.map((r) => r.id);
    try {
      await dnr.updateDynamicRules({ removeRuleIds, addRules: [...desired] });
      return new Set();
    } catch (batchError) {
      await dnr.updateDynamicRules({ removeRuleIds });
      const failed = await addIndividually(desired);
      if (failed.size === 0) {
        await recorder.recordError(
          `Batch update failed but rules applied individually: ${errorMessage(batchError)}`,
        );
      }
      return failed;
    }
  }

  async function deploy(rules: readonly Rule[], allowlist: readonly string[]): Promise<Deployment> {
    const compiled = compileToDNR(rules, DNR_ID_RANGE.userRuleBase);
    const ruleIdByDnrId = new Map(
      Object.entries(compiled.dnrIdByRuleId).map(([ruleId, dnrId]) => [dnrId, ruleId]),
    );
    const jsOnlyRuleIds = new Set(compiled.jsOnlyRuleIds);
    const jsOnlyReasons = { ...compiled.jsOnlyReasons };
    const demote = (dnrId: number, reason: string) => {
      const ruleId = ruleIdByDnrId.get(dnrId);
      if (!ruleId) return;
      jsOnlyRuleIds.add(ruleId);
      jsOnlyReasons[ruleId] = reason;
    };

    // Demote regexes the engine says it cannot handle (RE2 memory limit etc.).
    const accepted: DnrRule[] = [];
    for (const rule of compiled.dnrRules) {
      if (await isRegexSupported(rule)) accepted.push(rule);
      else demote(rule.id, "browser rejected the regex (isRegexSupported)");
    }

    const desired = [...allowlistToDNR(allowlist, DNR_ID_RANGE.siteAllowBase), ...accepted];
    const failed = await replaceDynamicRules(desired);
    for (const dnrId of failed) demote(dnrId, "browser rejected the dynamic rule");

    return {
      jsOnlyRuleIds,
      jsOnlyReasons,
      dnrRuleCount: accepted.filter((r) => !failed.has(r.id)).length,
    };
  }

  async function setTrackingEnabled(enabled: boolean): Promise<void> {
    const current = await dnr.getEnabledRulesets();
    const isOn = current.includes(TRACKING_RULESET_ID);
    if (enabled && !isOn) {
      await dnr.updateEnabledRulesets({ enableRulesetIds: [TRACKING_RULESET_ID] });
    }
    if (!enabled && isOn) {
      await dnr.updateEnabledRulesets({ disableRulesetIds: [TRACKING_RULESET_ID] });
    }
  }

  return { deploy, setTrackingEnabled, isRegexSupported };
}

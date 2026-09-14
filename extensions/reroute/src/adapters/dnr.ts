import { browser, type Browser } from "wxt/browser";
import type { DnrPort } from "../lib/background/rule-deployer";

/** `browser.declarativeNetRequest` behind the deployer's port. Every call is resolved lazily. */
export const browserDnr: DnrPort = {
  getDynamicRules: () => browser.declarativeNetRequest.getDynamicRules(),
  updateDynamicRules: ({ removeRuleIds, addRules }) =>
    browser.declarativeNetRequest.updateDynamicRules({
      ...(removeRuleIds ? { removeRuleIds } : {}),
      ...(addRules ? { addRules: addRules as Browser.declarativeNetRequest.Rule[] } : {}),
    }),
  getEnabledRulesets: () => browser.declarativeNetRequest.getEnabledRulesets(),
  updateEnabledRulesets: (options) => browser.declarativeNetRequest.updateEnabledRulesets(options),
  async isRegexSupported(options) {
    const api = browser.declarativeNetRequest;
    // Firefox has no isRegexSupported; treat every regex as supported and let the update decide.
    if (typeof api.isRegexSupported !== "function") return { isSupported: true };
    return api.isRegexSupported(options);
  },
};

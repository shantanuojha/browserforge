import { browser } from "wxt/browser";
import type { ContentScriptMessenger } from "../lib/background/copy-clean-link";
import type { RedirectTabsPort } from "../lib/background/redirect-fallback";

/** `browser.tabs` behind the two things the background does with a tab. */
export const browserTabs: RedirectTabsPort & ContentScriptMessenger = {
  async update(tabId, url) {
    await browser.tabs.update(tabId, { url });
  },
  async sendToTab(tabId, message, frameId) {
    const options = frameId !== undefined ? { frameId } : undefined;
    await browser.tabs.sendMessage(tabId, message, options);
  },
};

import { createLogger } from "@browserforge/shared";
import { browser, type Browser } from "wxt/browser";
import { hostFromTabUrl } from "../lib/planner.js";
import { tabUrl } from "./extension-api.js";

const MENU_WHITELIST = "cookiesweep:whitelist-site";
const MENU_CLEAN = "cookiesweep:clean-site";
const log = createLogger("cookiesweep:menus");

function createMenu(props: Browser.contextMenus.CreateProperties): void {
  try {
    browser.contextMenus.create(props, () => {
      // Read lastError so Chrome does not log "Unchecked runtime.lastError".
      void browser.runtime.lastError;
    });
  } catch (error) {
    log.warn("contextMenus.create failed", error);
  }
}

/** (Re)creates both entries; safe to call on every install and startup. */
export async function setupContextMenus(): Promise<void> {
  if (!browser.contextMenus) return;
  try {
    await browser.contextMenus.removeAll();
  } catch (error) {
    log.warn("contextMenus.removeAll failed", error);
  }
  // The toolbar-icon context is "action" on MV3 and "browser_action" on Firefox MV2.
  const manifestVersion = browser.runtime.getManifest().manifest_version;
  const contexts = ["page", manifestVersion >= 3 ? "action" : "browser_action"] as const;
  const documentUrlPatterns = ["http://*/*", "https://*/*"];
  createMenu({
    id: MENU_WHITELIST,
    title: "Whitelist this site",
    contexts: [...contexts],
    documentUrlPatterns,
  });
  createMenu({
    id: MENU_CLEAN,
    title: "Clean this site now",
    contexts: [...contexts],
    documentUrlPatterns,
  });
}

export interface MenuHandlers {
  whitelistSite(host: string, tabId: number | undefined): void;
  cleanSite(host: string, tabId: number | undefined): void;
}

/** Routes clicks on our two entries; no-op on browsers without context menus. */
export function onContextMenuClicked(handlers: MenuHandlers): void {
  if (!browser.contextMenus) return;
  browser.contextMenus.onClicked.addListener((info, tab) => {
    const host = hostFromTabUrl(info.pageUrl ?? tabUrl(tab));
    if (!host) return;
    if (info.menuItemId === MENU_WHITELIST) handlers.whitelistSite(host, tab?.id);
    else if (info.menuItemId === MENU_CLEAN) handlers.cleanSite(host, tab?.id);
  });
}

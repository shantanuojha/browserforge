import { browser } from "wxt/browser";
import type { CopyCleanLinkRequest } from "../lib/background/copy-clean-link";

const MENU_COPY_CLEAN = "reroute-copy-clean-link";

/** (Re)creates the "Copy clean link" entry; safe to call on every install and startup. */
export async function installCopyCleanLinkMenu(): Promise<void> {
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

/** Invokes `handler` with the link (or page) URL when our menu entry is clicked. */
export function onCopyCleanLinkClicked(handler: (request: CopyCleanLinkRequest) => void): void {
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_COPY_CLEAN) return;
    const url = info.linkUrl ?? info.pageUrl;
    if (!url || tab?.id === undefined) return;
    handler(
      info.frameId !== undefined
        ? { url, tabId: tab.id, frameId: info.frameId }
        : { url, tabId: tab.id },
    );
  });
}

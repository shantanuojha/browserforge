import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { isMessage } from "../lib/messages";

/**
 * Minimal content script: the background cannot touch the clipboard, so the
 * "Copy clean link" context-menu handler sends the cleaned URL here and the page
 * context writes it. It does nothing else and reads nothing from the page.
 */
export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  main() {
    browser.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
      if (!isMessage(raw) || raw.type !== "reroute:copy-text") return;
      void copyText(raw.text).then((ok) => sendResponse({ ok }));
      return true;
    });
  },
});

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

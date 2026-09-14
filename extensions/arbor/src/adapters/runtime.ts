/** `browser.runtime` lifecycle events and page navigation helpers. */
import { browser } from "wxt/browser";

export function onInstalled(listener: () => void): void {
  browser.runtime.onInstalled.addListener(listener);
}

export function onStartup(listener: () => void): void {
  browser.runtime.onStartup.addListener(listener);
}

/** `runtime.onSuspend` is missing in some browsers; the listener is simply not registered then. */
export function onSuspend(listener: () => void): void {
  browser.runtime.onSuspend?.addListener(listener);
}

export function openOptionsPage(): void {
  void browser.runtime.openOptionsPage();
}

/** Open one of the extension's own pages (e.g. the side panel HTML) in a new tab. */
export async function openExtensionPage(path: "/sidepanel.html"): Promise<void> {
  await browser.tabs.create({ url: browser.runtime.getURL(path) });
}

/** Id of the window the calling page belongs to. */
export async function currentWindowId(): Promise<number | undefined> {
  const win = await browser.windows.getCurrent();
  return win.id;
}

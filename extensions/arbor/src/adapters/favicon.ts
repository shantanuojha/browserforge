/**
 * Chromium exposes cached favicons at `chrome-extension://<id>/_favicon/` when the `favicon`
 * permission is granted. Other browsers get `null` and rows fall back to a generic icon.
 */
import { browser } from "wxt/browser";

export type FaviconFallback = (url: string) => string;

export function faviconFallback(): FaviconFallback | null {
  const chromium = "sidePanel" in browser;
  if (!chromium || typeof chrome === "undefined" || !chrome.runtime?.getURL) return null;
  const base = chrome.runtime.getURL("/_favicon/");
  return (url) => `${base}?pageUrl=${encodeURIComponent(url)}&size=16`;
}

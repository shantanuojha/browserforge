/** Optional permissions. Only `identity` (Google Drive backup, not shipped yet) is ever asked for. */
import { browser } from "wxt/browser";

export function hasIdentityPermission(): Promise<boolean> {
  return browser.permissions.contains({ permissions: ["identity"] });
}

export function requestIdentityPermission(): Promise<boolean> {
  return browser.permissions.request({ permissions: ["identity"] });
}

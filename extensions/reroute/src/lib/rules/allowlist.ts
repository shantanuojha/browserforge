/**
 * The per-site allowlist: hosts on which Reroute does nothing (no redirect rules, no tracking
 * cleanup). Entries use the shared `hostMatchesPattern` syntax (`host`, `*.host`, `*host`).
 */

import { hostMatchesAny, normalizeHost } from "@browserforge/shared";

/** Normalises user input to a storable pattern, or null when it is not host-like. */
export function normalizeAllowlistEntry(input: string): string | null {
  const host = normalizeHost(input).replace(/\/.*$/, "");
  if (!host) return null;
  if (!/^\*?\.?[a-z0-9.-]+$/i.test(host)) return null;
  return host;
}

export function isHostAllowlisted(host: string, allowlist: readonly string[]): boolean {
  return allowlist.length > 0 && hostMatchesAny(host, allowlist);
}

/** False for URLs without a hostname (about:, data:, malformed). */
export function isUrlAllowlisted(url: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return false;
  try {
    return hostMatchesAny(new URL(url).hostname, allowlist);
  } catch {
    return false;
  }
}

/** Adds the exact host; a no-op when it is already listed verbatim. */
export function addHostToAllowlist(allowlist: readonly string[], host: string): string[] {
  return allowlist.includes(host) ? [...allowlist] : [...allowlist, host];
}

/** Removes every pattern that matches `host`, so the site is rerouted again. */
export function removeHostFromAllowlist(allowlist: readonly string[], host: string): string[] {
  return allowlist.filter((pattern) => !hostMatchesAny(host, [pattern]));
}

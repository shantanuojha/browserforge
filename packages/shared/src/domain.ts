/**
 * Hostname helpers shared by CookieSweep (whitelists), Reroute (per-site
 * allowlists) and Arbor (grouping by site).
 *
 * Patterns follow the convention most MV2-era extensions used:
 *   "example.com"    exact host
 *   "*.example.com"  any subdomain (but not the bare apex)
 *   "*example.com"   apex or any subdomain
 */

export function normalizeHost(input: string): string {
  let host = input.trim().toLowerCase();
  if (host.startsWith("http://") || host.startsWith("https://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      // fall through with the raw string
    }
  }
  host = host.replace(/^\.+/, "").replace(/\.+$/, "");
  return host;
}

export function hostMatchesPattern(hostname: string, pattern: string): boolean {
  const host = normalizeHost(hostname);
  const pat = normalizeHost(pattern);
  if (!host || !pat) return false;
  if (pat.startsWith("*.")) {
    const suffix = pat.slice(1); // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  if (pat.startsWith("*")) {
    const apex = pat.slice(1); // "example.com"
    return host === apex || host.endsWith("." + apex);
  }
  return host === pat;
}

export function hostMatchesAny(hostname: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => hostMatchesPattern(hostname, p));
}

/**
 * Returns the registrable-ish "site" for grouping purposes without a public
 * suffix list: the last two labels, or last three when the second-level label
 * is a common ccTLD prefix (co.uk, com.au, ...). Good enough for UI grouping;
 * never use for security decisions.
 */
export function siteOf(hostname: string): string {
  const host = normalizeHost(hostname);
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return host;
  const secondLevel = labels[labels.length - 2];
  const tld = labels[labels.length - 1];
  const looksLikeCcSld =
    tld !== undefined &&
    tld.length === 2 &&
    secondLevel !== undefined &&
    ["co", "com", "org", "net", "gov", "edu", "ac"].includes(secondLevel);
  return labels.slice(looksLikeCcSld ? -3 : -2).join(".");
}

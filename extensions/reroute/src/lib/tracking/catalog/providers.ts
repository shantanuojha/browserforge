/**
 * The ClearURLs catalog model. Catalog: https://rules2.clearurls.xyz/data.minify.json
 * (LGPL-3.0, see public/rules/ATTRIBUTION.md).
 *
 * Imported by `scripts/build-tracking-rules.mjs` through Node's type stripping, so this module
 * stays dependency-free and imports relative modules with explicit `.ts` extensions.
 */

export interface ClearUrlsProvider {
  name: string;
  /** Regex (case-insensitive) that the full URL must match. */
  urlPattern: string;
  /** Whole provider is a tracker (ClearURLs blocks it). We skip these. */
  completeProvider: boolean;
  /** Regexes matched against a query parameter *name*, anchored, case-insensitive. */
  rules: string[];
  /** Regexes applied to the raw URL and replaced by "" (not expressible in DNR). */
  rawRules: string[];
  /** Referral parameters ClearURLs only strips when the option is on. */
  referralMarketing: string[];
  /** URL regexes where the provider must not apply. */
  exceptions: string[];
  /** URL regexes whose first capture is the real destination. */
  redirections: string[];
  forceRedirection: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function parseClearUrlsCatalog(json: unknown): ClearUrlsProvider[] {
  if (!isRecord(json) || !isRecord(json.providers)) {
    throw new Error('Not a ClearURLs catalog: missing "providers" object');
  }
  const out: ClearUrlsProvider[] = [];
  for (const [name, raw] of Object.entries(json.providers)) {
    if (!isRecord(raw) || typeof raw.urlPattern !== "string") continue;
    out.push({
      name,
      urlPattern: raw.urlPattern,
      completeProvider: raw.completeProvider === true,
      rules: strings(raw.rules),
      rawRules: strings(raw.rawRules),
      referralMarketing: strings(raw.referralMarketing),
      exceptions: strings(raw.exceptions),
      redirections: strings(raw.redirections),
      forceRedirection: raw.forceRedirection === true,
    });
  }
  return out;
}

/** Minimal bundled fallback used when the catalog cannot be fetched at build time. */
export const FALLBACK_PROVIDERS: ClearUrlsProvider[] = [
  {
    name: "globalRules",
    urlPattern: ".*",
    completeProvider: false,
    rules: ["utm(?:_[a-z_]*)?", "fbclid", "gclid", "msclkid", "mc_eid", "igshid", "ref_src"],
    rawRules: [],
    referralMarketing: [],
    exceptions: [],
    redirections: [],
    forceRedirection: false,
  },
  {
    name: "youtube",
    urlPattern: "^https?:\\/\\/(?:[a-z0-9-]+\\.)*?(?:youtube\\.com|youtu\\.be)",
    completeProvider: false,
    rules: ["si"],
    rawRules: [],
    referralMarketing: [],
    exceptions: [],
    redirections: [],
    forceRedirection: false,
  },
];

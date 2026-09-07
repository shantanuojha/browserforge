/**
 * ClearURLs catalog -> static DNR `removeParams` rules.
 *
 * This module is imported both by the extension (JS-side cleaner) and by
 * `scripts/build-tracking-rules.mjs` through Node's type stripping, so it must
 * stay dependency-free, use erasable TypeScript only, and import relative
 * modules with explicit `.ts` extensions.
 *
 * Catalog: https://rules2.clearurls.xyz/data.minify.json (LGPL-3.0, see
 * public/rules/ATTRIBUTION.md).
 */

import type { DnrRule } from "../dnr.ts";
import { DNR_PRIORITY } from "../dnr.ts";
import { isRE2Compatible } from "../rules/re2.ts";

// ---------------------------------------------------------------------------
// Catalog model
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Parameter-name rules: literal vs regex
// ---------------------------------------------------------------------------

/** ClearURLs prefixes many rules with `(?:%3F)?` to also catch encoded `?`. Strip it. */
export function stripEncodedQuestionPrefix(rule: string): string {
  return rule.replace(/^\(\?:%3F\)\?/, "");
}

const REGEX_META = /[.*+?^${}()|[\]\\]/;

/**
 * If the rule is a plain parameter name (possibly with escaped `\-`, `\.`,
 * `\_`), returns the literal name; otherwise null.
 */
export function literalParamName(rule: string): string | null {
  const src = stripEncodedQuestionPrefix(rule);
  if (src.length === 0) return null;
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    if (ch === "\\") {
      const next = src[i + 1];
      if (next === undefined) return null;
      // Escaped punctuation is literal; escaped letters are classes (\d, \w...).
      if (/[A-Za-z0-9]/.test(next)) return null;
      out += next;
      i++;
      continue;
    }
    if (REGEX_META.test(ch)) return null;
    if (/\s/.test(ch)) return null;
    out += ch;
  }
  return out;
}

export interface ClassifiedParams {
  literal: string[];
  regex: string[];
}

export function classifyParamRules(rules: readonly string[]): ClassifiedParams {
  const literal = new Set<string>();
  const regex: string[] = [];
  for (const rule of rules) {
    const lit = literalParamName(rule);
    if (lit !== null) literal.add(lit);
    else regex.push(stripEncodedQuestionPrefix(rule));
  }
  return { literal: [...literal], regex };
}

/** Names matched by a ClearURLs parameter regex, taken from `candidates`. */
export function expandParamRegex(regex: string, candidates: readonly string[]): string[] {
  let re: RegExp;
  try {
    re = new RegExp(`^(?:${regex})$`, "i");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const c of candidates) if (re.test(c)) out.push(c);
  return out;
}

/**
 * Curated corpus of real-world tracking parameter names used to expand regex
 * rules such as `utm(?:_[a-z_]*)?` into the literal names DNR needs. Literal
 * names found anywhere in the catalog are added at build time.
 */
export const KNOWN_PARAM_NAMES: readonly string[] = [
  // Google Analytics / UTM family
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "utm_name",
  "utm_cid",
  "utm_reader",
  "utm_referrer",
  "utm_social",
  "utm_social_type",
  "utm_brand",
  "utm_expid",
  "utm_pubreferrer",
  "utm_swu",
  "utm_viz_id",
  "utm_creative",
  "utm_creative_format",
  "utm_marketing_tactic",
  "utm_source_platform",
  "utm_keyword",
  "utm_place",
  "utm_placement",
  "utm_int",
  "utm_ad",
  "utm_adgroup",
  "utm_campaignid",
  "utm_channel",
  "utm_type",
  "utm_product",
  "utm_emailid",
  "utm_email",
  "utm_ref",
  "utm_sq",
  "utm_ct",
  "utm_supplier",
  "utm_ga",
  "utm",
  "ga_source",
  "ga_medium",
  "ga_term",
  "ga_content",
  "ga_campaign",
  "ga_place",
  "ga_fc",
  "ga_sid",
  "ga_hid",
  "ga_vid",
  // Matomo / Piwik
  "mtm_source",
  "mtm_medium",
  "mtm_campaign",
  "mtm_keyword",
  "mtm_content",
  "mtm_cid",
  "mtm_group",
  "mtm_placement",
  "pk_campaign",
  "pk_kwd",
  "pk_keyword",
  "pk_source",
  "pk_medium",
  "pk_content",
  "pk_cid",
  "piwik_campaign",
  "piwik_kwd",
  // Other campaign-tag families
  "itm_source",
  "itm_medium",
  "itm_campaign",
  "itm_content",
  "itm_term",
  "hmb_campaign",
  "hmb_medium",
  "hmb_source",
  "otm_source",
  "otm_medium",
  "otm_campaign",
  "otm_content",
  "otm_term",
  "vn_source",
  "vn_medium",
  "vn_campaign",
  "vn_content",
  "vn_term",
  "vn_source_medium",
  "mc_eid",
  "mc_cid",
  "mc_tc",
  "wt_mc",
  "wt_zmc",
  "wtmc",
  "wtzmc",
  "xmc",
  "umc",
  "mc",
  "wt_mc_o",
  "cmp",
  "cmpid",
  "ref",
  "ref_",
  "ref_src",
  "ref_url",
  "ref_source",
  "referrer",
  "sr",
  "srs",
  "sr_share",
  "ie",
  "spm",
  // Amazon
  "pf_rd_r",
  "pf_rd_p",
  "pf_rd_m",
  "pf_rd_s",
  "pf_rd_t",
  "pf_rd_i",
  "pd_rd_r",
  "pd_rd_w",
  "pd_rd_wg",
  "pd_rd_i",
  "pd_rd_plhdr",
  "colid",
  "coliid",
  "__mk_de_DE",
  "__mk_en_US",
  "__mk_en_GB",
  "__mk_fr_FR",
  "__mk_it_IT",
  "__mk_es_ES",
  "__mk_ja_JP",
  "__mk_nl_NL",
  "__mk_pt_BR",
  "__mk_zh_CN",
  "__mk_sv_SE",
  "__mk_pl_PL",
  "__mk_tr_TR",
  "__mk_ar_AE",
  "__mk_en_CA",
  "__mk_en_IN",
  "__mk_en_AU",
  "__mk_es_MX",
  "sb-ci-n",
  "sb-ci-v",
  "sb-ci-p",
  "sb-ci-a",
  "cv_ct_cx",
  "cv_ct_id",
  "cv_ct_pg",
  "cv_ct_wn",
  "cv_ct_we",
  "cv_ct_us",
  // Social / ads click ids
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "twclid",
  "ttclid",
  "igshid",
  "igsh",
  "yclid",
  "li_fat_id",
  "s_cid",
  "vero_conv",
  "vero_id",
  "wickedid",
  "oly_anon_id",
  "oly_enc_id",
  "rb_clickid",
  "_ga",
  "_gl",
  "_hsenc",
  "_hsmi",
  "__hsfp",
  "__hssc",
  "__hstc",
  "__s",
  "hsCtaTracking",
  "mkt_tok",
  "ml_subscriber",
  "ml_subscriber_hash",
  "srsltid",
  "si",
  "feature",
  "share_id",
  "trk",
  "trkcampaign",
  "trkinfo",
  "trkemail",
  "trk_contact",
  "trk_msg",
  "trk_module",
  "trk_sid",
  "action_object_map",
  "action_type_map",
  "action_ref_map",
  "fb_action_ids",
  "fb_action_types",
  "fb_source",
  "fb_ref",
  "_openstat",
  "os_ehash",
  "ceneo_spo",
  "tracking_source",
  "echobox",
  "__twitter_impression",
  "wtrid",
  "gs_l",
  "ncid",
  "nr_email_referer",
  "sc_campaign",
  "sc_channel",
  "sc_content",
  "sc_medium",
  "sc_outcome",
  "sc_geo",
  "sc_country",
  // Google search / apps
  "sca_esv",
  "sca_upv",
  "gws_rd",
  "gfe_rd",
  "btnI",
  "btnG",
  "btnK",
  // Facebook
  "hc_location",
  "hc_ref",
  // Netflix
  "jbv",
  "jbp",
  "jbr",
  // Walmart
  "athcpid",
  "athpgid",
  "athcgid",
  "athznid",
  "athieid",
  "athstid",
  "athguid",
  "athancid",
  "athena",
  "athbdg",
  // Apple
  "ign-itsct",
  "ign-itscg",
  // BBC
  "at_medium",
  "at_campaign",
  "at_custom1",
  "at_custom2",
  "at_custom3",
  "at_custom4",
  "at_link_id",
  "at_link_origin",
  "at_link_type",
  "at_ptr_name",
  "at_bbc_team",
  "at_format",
  // Flipkart / MercadoLibre / Bloculus / Big Fish
  "otracker",
  "otracker1",
  "c_id",
  "c_uid",
  "c_source",
  "c_element",
  "c_campaign",
  "me.bucket",
  "me.order",
  "me.page",
  "tl_inbound",
  "tl_target_all",
  "tl_period_type",
  "tl_email_id",
  "npv1",
  "npv2",
];

// ---------------------------------------------------------------------------
// URL pattern -> DNR condition
// ---------------------------------------------------------------------------

export type UrlCondition =
  | { kind: "all" }
  | { kind: "domains"; requestDomains: string[] }
  | { kind: "regex"; regexFilter: string }
  | { kind: "unsupported"; reason: string };

const ANY_PATTERNS = new Set([".*", "^.*$", ".*?", "^.*", ".*$", ""]);

/**
 * Recognises the canonical ClearURLs shapes
 *   ^https?:\/\/(?:[a-z0-9-]+\.)*?example\.com
 *   ^https?:\/\/(?:www\.)?example\.com
 *   ^https?:\/\/(?:[a-z0-9-]+\.)*?(?:a\.com|b\.org)
 * and turns them into `requestDomains`, which do not count against the regex
 * limit. Anything else becomes a regexFilter when RE2-safe.
 */
export function urlPatternToCondition(urlPattern: string): UrlCondition {
  const p = urlPattern.trim();
  if (ANY_PATTERNS.has(p)) return { kind: "all" };

  const m =
    /^\^https\?:\\\/\\\/(?:\(\?:\[a-z0-9-\]\+\\\.\)\*\??|\(\?:www\\\.\)\?)?(\((?:\?:)?[^()$]+\)|[^()$]+)\$?$/i.exec(
      p,
    );
  if (m) {
    const body = m[1] as string;
    let inner = body;
    if (inner.startsWith("(?:")) inner = inner.slice(3, -1);
    else if (inner.startsWith("(")) inner = inner.slice(1, -1);
    const alternatives = inner.split("|");
    const domains: string[] = [];
    for (const alt of alternatives) {
      // Must be a literal host: labels of [a-z0-9-] separated by escaped dots.
      if (!/^[a-z0-9-]+(?:\\\.[a-z0-9-]+)+$/i.test(alt)) {
        domains.length = 0;
        break;
      }
      domains.push(alt.replace(/\\\./g, ".").toLowerCase());
    }
    if (domains.length > 0) return { kind: "domains", requestDomains: domains };
  }

  if (!isRE2Compatible(p)) return { kind: "unsupported", reason: "urlPattern is not RE2-safe" };
  return { kind: "regex", regexFilter: p };
}

// ---------------------------------------------------------------------------
// Rule generation
// ---------------------------------------------------------------------------

export interface SkippedProvider {
  name: string;
  reason: string;
}
export interface SkippedParam {
  provider: string;
  regex: string;
}

export interface TrackingBuildReport {
  providersTotal: number;
  providersUsed: number;
  providersSkipped: SkippedProvider[];
  rulesGenerated: number;
  removeParamRules: number;
  exceptionRules: number;
  regexRules: number;
  literalParams: number;
  expandedParams: number;
  skippedParamRegexes: SkippedParam[];
  exceptionsSkipped: SkippedParam[];
  rawRulesSkipped: number;
  redirectionsSkipped: number;
  referralMarketingSkipped: number;
}

export interface TrackingBuildOptions {
  /** Extra literal names used when expanding regex parameter rules. */
  extraCandidates?: readonly string[];
  /** Emit `allow` rules for provider exceptions (default true). */
  includeExceptions?: boolean;
}

export const TRACKING_RESOURCE_TYPES = ["main_frame", "sub_frame"] as const;

export interface TrackingRuleSet {
  rules: DnrRule[];
  report: TrackingBuildReport;
}

export function toRemoveParamsRules(
  providers: readonly ClearUrlsProvider[],
  idBase = 1,
  options: TrackingBuildOptions = {},
): TrackingRuleSet {
  const includeExceptions = options.includeExceptions ?? true;

  // Candidate corpus for regex expansion: curated names + every literal in the catalog.
  const candidateSet = new Set<string>(KNOWN_PARAM_NAMES);
  for (const c of options.extraCandidates ?? []) candidateSet.add(c);
  for (const p of providers) {
    for (const lit of classifyParamRules(p.rules).literal) candidateSet.add(lit);
  }
  const candidates = [...candidateSet];

  const rules: DnrRule[] = [];
  const report: TrackingBuildReport = {
    providersTotal: providers.length,
    providersUsed: 0,
    providersSkipped: [],
    rulesGenerated: 0,
    removeParamRules: 0,
    exceptionRules: 0,
    regexRules: 0,
    literalParams: 0,
    expandedParams: 0,
    skippedParamRegexes: [],
    exceptionsSkipped: [],
    rawRulesSkipped: 0,
    redirectionsSkipped: 0,
    referralMarketingSkipped: 0,
  };
  let nextId = idBase;
  const exceptionSeen = new Set<string>();

  for (const provider of providers) {
    report.rawRulesSkipped += provider.rawRules.length;
    report.redirectionsSkipped += provider.redirections.length;
    report.referralMarketingSkipped += provider.referralMarketing.length;

    if (provider.completeProvider) {
      report.providersSkipped.push({ name: provider.name, reason: "completeProvider (blocking)" });
      continue;
    }
    if (/^ClearURLsTest/i.test(provider.name)) {
      report.providersSkipped.push({ name: provider.name, reason: "ClearURLs self-test provider" });
      continue;
    }
    const condition = urlPatternToCondition(provider.urlPattern);
    if (condition.kind === "unsupported") {
      report.providersSkipped.push({ name: provider.name, reason: condition.reason });
      continue;
    }

    const { literal, regex } = classifyParamRules(provider.rules);
    const params = new Set<string>(literal);
    report.literalParams += literal.length;
    for (const rx of regex) {
      const expanded = expandParamRegex(rx, candidates);
      if (expanded.length === 0) {
        report.skippedParamRegexes.push({ provider: provider.name, regex: rx });
        continue;
      }
      for (const name of expanded) {
        if (!params.has(name)) {
          params.add(name);
          report.expandedParams++;
        }
      }
    }
    if (params.size === 0) {
      report.providersSkipped.push({ name: provider.name, reason: "no expressible parameters" });
      continue;
    }

    const dnrCondition: DnrRule["condition"] = {
      resourceTypes: [...TRACKING_RESOURCE_TYPES],
    };
    if (condition.kind === "domains") dnrCondition.requestDomains = condition.requestDomains;
    if (condition.kind === "regex") {
      dnrCondition.regexFilter = condition.regexFilter;
      dnrCondition.isUrlFilterCaseSensitive = false;
      report.regexRules++;
    }

    rules.push({
      id: nextId++,
      priority: DNR_PRIORITY.tracking,
      condition: dnrCondition,
      action: {
        type: "redirect",
        redirect: { transform: { queryTransform: { removeParams: [...params].sort() } } },
      },
    });
    report.removeParamRules++;
    report.providersUsed++;

    if (includeExceptions) {
      for (const exc of provider.exceptions) {
        if (exceptionSeen.has(exc)) continue;
        exceptionSeen.add(exc);
        if (!isRE2Compatible(exc)) {
          report.exceptionsSkipped.push({ provider: provider.name, regex: exc });
          continue;
        }
        rules.push({
          id: nextId++,
          priority: DNR_PRIORITY.trackingException,
          condition: {
            regexFilter: exc,
            isUrlFilterCaseSensitive: false,
            resourceTypes: [...TRACKING_RESOURCE_TYPES],
          },
          action: { type: "allow" },
        });
        report.exceptionRules++;
        report.regexRules++;
      }
    }
  }

  report.rulesGenerated = rules.length;
  return { rules, report };
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

/**
 * ClearURLs providers -> static DNR `removeParams` rules plus `allow` exceptions.
 *
 * Chrome applies a single redirect rule per request and does not fall through when its
 * removeParams is a no-op, so a provider whose condition is covered by another's (the global
 * catch-all covers everyone; bilibili.com covers m.bilibili.com; ...) must outrank it and carry
 * its parameters too. Priorities therefore encode nesting depth.
 */

import type { DnrRule } from "../../dnr.ts";
import { DNR_PRIORITY } from "../../dnr.ts";
import { isRE2Compatible } from "../../rules/re2.ts";
import { conditionCovers, urlPatternToCondition, type UrlCondition } from "./conditions.ts";
import { KNOWN_PARAM_NAMES } from "./known-params.ts";
import { classifyParamRules, expandParamRegex } from "./params.ts";
import type { ClearUrlsProvider } from "./providers.ts";

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

type SupportedCondition = Exclude<UrlCondition, { kind: "unsupported" }>;

interface PreparedProvider {
  provider: ClearUrlsProvider;
  condition: SupportedCondition;
  params: Set<string>;
}

/** Mutable state threaded through one build. */
interface Build {
  rules: DnrRule[];
  report: TrackingBuildReport;
  nextId: number;
  exceptionSeen: Set<string>;
}

function emptyReport(providersTotal: number): TrackingBuildReport {
  return {
    providersTotal,
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
}

/** Literal names from the curated corpus, the caller's extras and every literal in the catalog. */
function candidateNames(
  providers: readonly ClearUrlsProvider[],
  extra: readonly string[] = [],
): string[] {
  const names = new Set<string>([...KNOWN_PARAM_NAMES, ...extra]);
  for (const provider of providers) {
    for (const literal of classifyParamRules(provider.rules).literal) names.add(literal);
  }
  return [...names];
}

/** Why a provider is left out before its parameters are even looked at, or null. */
function providerSkipReason(provider: ClearUrlsProvider): string | null {
  if (provider.completeProvider) return "completeProvider (blocking)";
  if (/^ClearURLsTest/i.test(provider.name)) return "ClearURLs self-test provider";
  return null;
}

/** Literal parameter names for a provider: its literals plus expanded regexes. */
function expandParams(
  provider: ClearUrlsProvider,
  candidates: readonly string[],
  report: TrackingBuildReport,
): Set<string> {
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
      if (params.has(name)) continue;
      params.add(name);
      report.expandedParams++;
    }
  }
  return params;
}

function prepareProvider(
  provider: ClearUrlsProvider,
  candidates: readonly string[],
  report: TrackingBuildReport,
): PreparedProvider | null {
  report.rawRulesSkipped += provider.rawRules.length;
  report.redirectionsSkipped += provider.redirections.length;
  report.referralMarketingSkipped += provider.referralMarketing.length;

  const skip = (reason: string): null => {
    report.providersSkipped.push({ name: provider.name, reason });
    return null;
  };
  const skipReason = providerSkipReason(provider);
  if (skipReason) return skip(skipReason);
  const condition = urlPatternToCondition(provider.urlPattern);
  if (condition.kind === "unsupported") return skip(condition.reason);
  const params = expandParams(provider, candidates, report);
  if (params.size === 0) return skip("no expressible parameters");
  return { provider, condition, params };
}

interface Coverage {
  /** `covered[i]` = indices whose condition covers i (transitively). */
  covered: Set<number>[];
  /** `equivalent[i]` = indices whose condition matches exactly the same URLs as i. */
  equivalent: Set<number>[];
}

function addTransitiveCoverage(covered: Set<number>[]): void {
  for (let changed = true; changed;) {
    changed = false;
    for (const set of covered) {
      for (const i of [...set]) {
        for (const k of covered[i]!) {
          if (set.has(k)) continue;
          set.add(k);
          changed = true;
        }
      }
    }
  }
}

function computeCoverage(prepared: readonly PreparedProvider[]): Coverage {
  const covered = prepared.map(() => new Set<number>());
  const equivalent = prepared.map(() => new Set<number>());
  for (let i = 0; i < prepared.length; i++) {
    for (let j = 0; j < prepared.length; j++) {
      if (i === j) continue;
      const ij = conditionCovers(prepared[i]!.condition, prepared[j]!.condition);
      const ji = conditionCovers(prepared[j]!.condition, prepared[i]!.condition);
      if (ij && ji) equivalent[j]!.add(i);
      else if (ij) covered[j]!.add(i);
    }
  }
  addTransitiveCoverage(covered);
  return { covered, equivalent };
}

function toDnrCondition(condition: SupportedCondition, report: TrackingBuildReport) {
  const dnrCondition: DnrRule["condition"] = { resourceTypes: [...TRACKING_RESOURCE_TYPES] };
  if (condition.kind === "domains") dnrCondition.requestDomains = condition.requestDomains;
  if (condition.kind === "regex") {
    dnrCondition.regexFilter = condition.regexFilter;
    dnrCondition.isUrlFilterCaseSensitive = false;
    report.regexRules++;
  }
  return dnrCondition;
}

function emitRemoveParamsRule(
  build: Build,
  entry: PreparedProvider,
  params: Set<string>,
  depth: number,
) {
  const priority = DNR_PRIORITY.tracking + depth;
  if (priority >= DNR_PRIORITY.trackingException) {
    throw new Error(
      `Provider "${entry.provider.name}" is nested ${depth} deep; raise DNR_PRIORITY.trackingException`,
    );
  }
  build.rules.push({
    id: build.nextId++,
    priority,
    condition: toDnrCondition(entry.condition, build.report),
    action: {
      type: "redirect",
      redirect: { transform: { queryTransform: { removeParams: [...params].sort() } } },
    },
  });
  build.report.removeParamRules++;
  build.report.providersUsed++;
}

function emitExceptionRules(build: Build, provider: ClearUrlsProvider): void {
  for (const exception of provider.exceptions) {
    if (build.exceptionSeen.has(exception)) continue;
    build.exceptionSeen.add(exception);
    if (!isRE2Compatible(exception)) {
      build.report.exceptionsSkipped.push({ provider: provider.name, regex: exception });
      continue;
    }
    build.rules.push({
      id: build.nextId++,
      priority: DNR_PRIORITY.trackingException,
      condition: {
        regexFilter: exception,
        isUrlFilterCaseSensitive: false,
        resourceTypes: [...TRACKING_RESOURCE_TYPES],
      },
      action: { type: "allow" },
    });
    build.report.exceptionRules++;
    build.report.regexRules++;
  }
}

/** A provider's own parameters plus those of every provider that covers or equals it. */
function inheritedParams(prepared: readonly PreparedProvider[], coverage: Coverage, index: number) {
  const params = new Set<string>(prepared[index]!.params);
  for (const i of coverage.covered[index]!) for (const p of prepared[i]!.params) params.add(p);
  for (const i of coverage.equivalent[index]!) for (const p of prepared[i]!.params) params.add(p);
  return params;
}

export function toRemoveParamsRules(
  providers: readonly ClearUrlsProvider[],
  idBase = 1,
  options: TrackingBuildOptions = {},
): TrackingRuleSet {
  const includeExceptions = options.includeExceptions ?? true;
  const build: Build = {
    rules: [],
    report: emptyReport(providers.length),
    nextId: idBase,
    exceptionSeen: new Set(),
  };
  const candidates = candidateNames(providers, options.extraCandidates);
  const prepared = providers
    .map((provider) => prepareProvider(provider, candidates, build.report))
    .filter((entry): entry is PreparedProvider => entry !== null);
  const coverage = computeCoverage(prepared);

  prepared.forEach((entry, index) => {
    const params = inheritedParams(prepared, coverage, index);
    emitRemoveParamsRule(build, entry, params, coverage.covered[index]!.size);
    if (includeExceptions) emitExceptionRules(build, entry.provider);
  });

  build.report.rulesGenerated = build.rules.length;
  return { rules: build.rules, report: build.report };
}

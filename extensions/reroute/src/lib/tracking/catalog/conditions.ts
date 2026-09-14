/**
 * Provider URL patterns as DNR conditions, and the "covers" relation between them that decides
 * rule priorities (see `generate.ts`).
 */

import { isRE2Compatible } from "../../rules/re2.ts";

export type UrlCondition =
  | { kind: "all" }
  | { kind: "domains"; requestDomains: string[] }
  | { kind: "regex"; regexFilter: string }
  | { kind: "unsupported"; reason: string };

const ANY_PATTERNS = new Set([".*", "^.*$", ".*?", "^.*", ".*$", ""]);

/** `^https?:\/\/<optional subdomain group>(<alternatives>)$?` with the alternatives captured. */
const CANONICAL_HOST_PATTERN =
  /^\^https\?:\\\/\\\/(?:\(\?:\[a-z0-9-\]\+\\\.\)\*\??|\(\?:www\\\.\)\?)?(\((?:\?:)?[^()$]+\)|[^()$]+)\$?$/i;

/** Literal hosts named by an alternation body such as `a\.com|b\.org`; empty when any is not literal. */
function literalHosts(body: string): string[] {
  let inner = body;
  if (inner.startsWith("(?:")) inner = inner.slice(3, -1);
  else if (inner.startsWith("(")) inner = inner.slice(1, -1);
  const alternatives = inner.split("|");
  // Must be a literal host: labels of [a-z0-9-] separated by escaped dots.
  if (!alternatives.every((alt) => /^[a-z0-9-]+(?:\\\.[a-z0-9-]+)+$/i.test(alt))) return [];
  return alternatives.map((alt) => alt.replace(/\\\./g, ".").toLowerCase());
}

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

  const m = CANONICAL_HOST_PATTERN.exec(p);
  if (m) {
    const domains = literalHosts(m[1] as string);
    if (domains.length > 0) return { kind: "domains", requestDomains: domains };
  }

  if (!isRE2Compatible(p)) return { kind: "unsupported", reason: "urlPattern is not RE2-safe" };
  return { kind: "regex", regexFilter: p };
}

function hostCovers(parent: string, host: string): boolean {
  return host === parent || host.endsWith("." + parent);
}

/**
 * The literal host a provider regex is anchored on, when it has the ClearURLs
 * shape `^https?:\/\/<optional subdomain group>host\.tld` followed by nothing
 * host-like (end, `$`, a path or a query). `terminal` is true when nothing at
 * all follows the host, i.e. the regex behaves like a domain condition.
 */
export function literalHostOfRegex(source: string): { host: string; terminal: boolean } | null {
  const m =
    /^\^?https\?:(?:\\\/\\\/|\/\/)(?:\(\?:\[a-z0-9-\]\+\\\.\)\*\??|\(\?:[a-z0-9-]+\\\.\)\?|\(\?:www\\\.\)\?)?((?:[a-z0-9-]+\\\.)+[a-z]{2,})(\$?$|\\\/|\/|\\\?|\[)/i.exec(
      source,
    );
  if (!m) return null;
  return {
    host: (m[1] as string).replace(/\\\./g, ".").toLowerCase(),
    terminal: /^\$?$/.test(m[2] as string),
  };
}

const QUANTIFIER_OR_ALTERNATION = /^[*+?{|]/;

type Concrete = Exclude<UrlCondition, { kind: "unsupported" | "all" }>;

function domainsCover(outer: string[], inner: Concrete): boolean {
  if (inner.kind === "domains") {
    return inner.requestDomains.every((h) => outer.some((p) => hostCovers(p, h)));
  }
  const host = literalHostOfRegex(inner.regexFilter);
  return host !== null && outer.some((p) => hostCovers(p, host.host));
}

/** `inner` is `outer` followed by more literal text: every match of `inner` also matches `outer`. */
function isLiteralExtension(outer: string, inner: string): boolean {
  if (inner === outer) return true;
  return inner.startsWith(outer) && !QUANTIFIER_OR_ALTERNATION.test(inner.slice(outer.length));
}

function regexCovers(outer: string, inner: Concrete): boolean {
  if (inner.kind === "regex" && isLiteralExtension(outer, inner.regexFilter)) return true;
  const outerHost = literalHostOfRegex(outer);
  if (!outerHost || !outerHost.terminal) return false;
  if (inner.kind === "domains") {
    return inner.requestDomains.every((h) => hostCovers(outerHost.host, h));
  }
  const innerHost = literalHostOfRegex(inner.regexFilter);
  return innerHost !== null && hostCovers(outerHost.host, innerHost.host);
}

/** True when every URL that matches `inner` also matches `outer`. Conservative. */
export function conditionCovers(outer: UrlCondition, inner: UrlCondition): boolean {
  if (outer.kind === "unsupported" || inner.kind === "unsupported") return false;
  if (outer.kind === "all") return true;
  if (inner.kind === "all") return false;
  if (outer.kind === "domains") return domainsCover(outer.requestDomains, inner);
  return regexCovers(outer.regexFilter, inner);
}

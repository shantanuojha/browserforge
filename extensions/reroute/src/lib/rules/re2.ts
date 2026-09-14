/**
 * Conservative static check: does a JavaScript regex source stay inside the
 * RE2 subset that `declarativeNetRequest.regexFilter` accepts?
 *
 * This is intentionally strict: anything we cannot prove safe is rejected and
 * the rule is served by the JS fallback instead. `isRegexSupported` remains
 * the authority at runtime; this check lets us decide synchronously and in
 * build scripts.
 *
 * Kept dependency-free so `scripts/build-tracking-rules.mjs` can import it via
 * Node's type stripping.
 */

export interface RE2CheckResult {
  ok: boolean;
  reason?: string;
}

const reject = (reason: string): RE2CheckResult => ({ ok: false, reason });

/**
 * Escapes whose meaning differs between JS and RE2 (or that RE2 lacks). JS reads `\A \z \Q \E
 * \C \a` as the plain letter; RE2 reads them as anchors, a literal span, "any byte" and BEL.
 */
const ESCAPE_PROBLEMS: Readonly<Record<string, string>> = {
  p: "unicode property escape",
  P: "unicode property escape",
  // \uXXXX is JS-only (RE2 uses \x{...}); \u{...} likewise.
  u: "\\u escape",
  c: "control escape",
  A: "\\A means something else in RE2",
  z: "\\z means something else in RE2",
  Q: "\\Q means something else in RE2",
  E: "\\E means something else in RE2",
  C: "\\C means something else in RE2",
  a: "\\a means something else in RE2",
};

/** Why `\<next>` is not RE2-safe, or null. Backreferences are only meaningful outside classes. */
function escapeProblem(next: string | undefined, inClass: boolean): string | null {
  if (next === undefined) return "trailing backslash";
  if (!inClass && next >= "1" && next <= "9") return "backreference";
  if (!inClass && next === "k") return "named backreference";
  return ESCAPE_PROBLEMS[next] ?? null;
}

/** Why a `(?` group with the two characters `tail` after it is not RE2-safe, or null. */
function groupProblem(tail: string): string | null {
  if (tail.startsWith("=") || tail.startsWith("!")) return "lookahead";
  if (tail === "<=" || tail === "<!") return "lookbehind";
  if (tail.startsWith("<")) return "named group";
  if (tail.startsWith(":")) return null; // non-capturing, fine
  // (?i) style inline flags are RE2-only and not valid JS; the JS parse rejects them first.
  return "unsupported group syntax";
}

function isPossessiveQuantifier(source: string, i: number): boolean {
  const ch = source[i];
  return (ch === "*" || ch === "+" || ch === "?" || ch === "}") && source[i + 1] === "+";
}

function hasNonAscii(source: string): boolean {
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) > 0x7f) return true;
  return false;
}

function jsParseError(source: string): string | null {
  try {
    new RegExp(source);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Walks the pattern once and returns the first construct RE2 would read differently, or null. */
function firstSyntaxProblem(source: string): string | null {
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      const problem = escapeProblem(source[i + 1], inClass);
      if (problem) return problem;
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      // A leading "]" inside a class is literal in JS ("[]" is an empty class);
      // RE2 treats it differently, so just reject the ambiguity.
      if (source[i + 1] === "]") return "empty character class";
      inClass = true;
      continue;
    }
    if (ch === "(" && source[i + 1] === "?") {
      const problem = groupProblem(source.slice(i + 2, i + 4));
      if (problem) return problem;
      continue;
    }
    if (isPossessiveQuantifier(source, i)) return "possessive quantifier";
  }
  return null;
}

export function checkRE2Compatible(source: string): RE2CheckResult {
  if (source.length === 0) return reject("empty pattern");
  // DNR requires ASCII-only regex filters.
  if (hasNonAscii(source)) return reject("non-ASCII character");
  // Must at least parse as a JS regex (we use it in the JS fallback too).
  const parseError = jsParseError(source);
  if (parseError !== null) return reject(`invalid regex: ${parseError}`);
  const problem = firstSyntaxProblem(source);
  return problem === null ? { ok: true } : reject(problem);
}

export function isRE2Compatible(source: string): boolean {
  return checkRE2Compatible(source).ok;
}

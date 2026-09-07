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

export function checkRE2Compatible(source: string): RE2CheckResult {
  if (source.length === 0) return { ok: false, reason: "empty pattern" };

  // DNR requires ASCII-only regex filters.
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) > 0x7f) return { ok: false, reason: "non-ASCII character" };
  }

  // Must at least parse as a JS regex (we use it in the JS fallback too).
  try {
    new RegExp(source);
  } catch (e) {
    return { ok: false, reason: `invalid regex: ${e instanceof Error ? e.message : String(e)}` };
  }

  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      const next = source[i + 1];
      if (next === undefined) return { ok: false, reason: "trailing backslash" };
      if (!inClass) {
        if (next >= "1" && next <= "9") return { ok: false, reason: "backreference" };
        if (next === "k") return { ok: false, reason: "named backreference" };
      }
      if (next === "p" || next === "P") return { ok: false, reason: "unicode property escape" };
      if (next === "u") {
        // \uXXXX is JS-only (RE2 uses \x{...}); \u{...} likewise.
        return { ok: false, reason: "\\u escape" };
      }
      if (next === "c") return { ok: false, reason: "control escape" };
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      // A leading "]" inside a class is literal in JS ("[]" is an empty class);
      // RE2 treats it differently, so just reject the ambiguity.
      if (source[i + 1] === "]") return { ok: false, reason: "empty character class" };
      continue;
    }
    if (ch === "(" && source[i + 1] === "?") {
      const tail = source.slice(i + 2, i + 4);
      if (tail.startsWith("=") || tail.startsWith("!")) return { ok: false, reason: "lookahead" };
      if (tail === "<=" || tail === "<!") return { ok: false, reason: "lookbehind" };
      if (tail.startsWith("<")) return { ok: false, reason: "named group" };
      if (tail.startsWith(":")) continue; // non-capturing, fine
      // (?i) style inline flags are RE2-only and not valid JS; JS parse above rejects them.
      return { ok: false, reason: "unsupported group syntax" };
    }
    if ((ch === "*" || ch === "+" || ch === "?" || ch === "}") && source[i + 1] === "+") {
      return { ok: false, reason: "possessive quantifier" };
    }
  }
  return { ok: true };
}

export function isRE2Compatible(source: string): boolean {
  return checkRE2Compatible(source).ok;
}

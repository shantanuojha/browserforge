/**
 * Parameter-name rules: ClearURLs expresses parameter names as anchored regexes. DNR needs
 * literal names, so plain names are recognised as such and regexes are expanded against a
 * corpus of known names.
 */

/** ClearURLs prefixes many rules with `(?:%3F)?` to also catch encoded `?`. Strip it. */
export function stripEncodedQuestionPrefix(rule: string): string {
  return rule.replace(/^\(\?:%3F\)\?/, "");
}

const REGEX_META = /[.*+?^${}()|[\]\\]/;

/** Escaped punctuation is literal; escaped letters and digits are classes (`\d`, `\w`, ...). */
function literalEscape(next: string | undefined): string | null {
  if (next === undefined || /[A-Za-z0-9]/.test(next)) return null;
  return next;
}

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
      const literal = literalEscape(src[i + 1]);
      if (literal === null) return null;
      out += literal;
      i++;
      continue;
    }
    if (REGEX_META.test(ch) || /\s/.test(ch)) return null;
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
  return candidates.filter((candidate) => re.test(candidate));
}

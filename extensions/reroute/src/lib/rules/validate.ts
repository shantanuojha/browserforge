/** Editor-side validation of a rule draft: the messages the form shows before it lets you save. */

import { isValidRegexSource, type Rule } from "./model";

export function validateRuleDraft(rule: Rule): string[] {
  const errors: string[] = [];
  if (!rule.include.trim()) errors.push("Include pattern is required.");
  if (!rule.redirectTo.trim()) errors.push("Redirect target is required.");
  if (rule.matchType !== "regex") return errors;
  if (rule.include && !isValidRegexSource(rule.include)) {
    errors.push("Include pattern is not a valid regular expression.");
  }
  for (const pattern of rule.exclude) {
    if (!isValidRegexSource(pattern)) {
      errors.push(`Exclude "${pattern}" is not a valid regular expression.`);
    }
  }
  return errors;
}

/** One pattern per line; blank lines are ignored. */
export function parseExcludeLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

import { useMemo } from "react";
import { matchRuleDetailed, testUrl } from "../lib/rules/engine";
import type { Rule } from "../lib/rules/model";

export interface RuleTesterProps {
  /** The rule being edited, with the current draft values. */
  rule: Rule;
  /** All rules, for "which rule fires first". */
  allRules: Rule[];
  url: string;
  onUrlChange: (url: string) => void;
}

/** `allRules` with the draft substituted in (or appended when it is new). */
function withDraft(allRules: Rule[], draft: Rule): Rule[] {
  const rules = allRules.map((r) => (r.id === draft.id ? draft : r));
  if (!rules.some((r) => r.id === draft.id)) rules.push(draft);
  return rules;
}

function describeFirstFiring(rule: Rule, allRules: Rule[], url: string): string {
  const firing = testUrl(url, withDraft(allRules, rule));
  if (!firing) return "No enabled rule fires for this URL.";
  if (firing.rule.id === rule.id) return "It is the first rule to fire for this URL.";
  const name = firing.rule.name || firing.rule.include;
  return `Another rule fires first: "${name}" -> ${firing.target}`;
}

/** Live tester: what this rule does with a URL, and whether another rule would win. */
export function RuleTester({ rule, allRules, url, onUrlChange }: RuleTesterProps) {
  const result = url ? matchRuleDetailed(url, { ...rule, enabled: true }) : null;
  const firstFiring = useMemo(
    () => (url ? describeFirstFiring(rule, allRules, url) : null),
    [url, allRules, rule],
  );

  return (
    <div className="rr-field">
      <label htmlFor="rule-test">Live tester</label>
      <input
        id="rule-test"
        className="rr-input rr-input--mono"
        value={url}
        onChange={(e) => onUrlChange(e.target.value)}
        placeholder="Paste a URL to see what this rule does"
        spellCheck={false}
      />
      {url ? (
        <div className={`rr-result ${result ? "rr-result--hit" : ""}`}>
          {result ? (
            <>
              <div>
                This rule redirects to <span className="rr-mono">{result.target}</span>
              </div>
              {result.groups.length > 0 ? (
                <div className="rr-small rr-muted">
                  Captures:{" "}
                  {result.groups.map((g, i) => (
                    <span key={i} className="rr-mono">
                      ${i + 1}={JSON.stringify(g)}{" "}
                    </span>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <div>This rule does not match.</div>
          )}
          <div className="rr-small rr-muted">{firstFiring}</div>
        </div>
      ) : null}
    </div>
  );
}

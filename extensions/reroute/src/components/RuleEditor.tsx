import { Button } from "@browserforge/ui";
import { useMemo, useState } from "react";
import { dnrIneligibilityReason, matchRuleDetailed, testUrl } from "../lib/rules/engine";
import {
  APPLY_TO,
  MATCH_TYPES,
  RESOURCE_TYPES,
  TRANSFORMS,
  isValidRegexSource,
  type ResourceType,
  type Rule,
  type Transform,
} from "../lib/rules/model";

export interface RuleEditorProps {
  rule: Rule;
  /** All rules, for "which rule fires first" in the tester. */
  allRules: Rule[];
  onSave: (rule: Rule) => void;
  onCancel: () => void;
}

const TRANSFORM_LABELS: Record<Transform, string> = {
  decodeURIComponent: "URL-decode",
  encodeURIComponent: "URL-encode",
  atob: "Base64-decode",
  btoa: "Base64-encode",
  lower: "Lower-case",
  upper: "Upper-case",
};

export function RuleEditor({ rule, allRules, onSave, onCancel }: RuleEditorProps) {
  const [draft, setDraft] = useState<Rule>(rule);
  const [excludeText, setExcludeText] = useState(rule.exclude.join("\n"));
  const [testInput, setTestInput] = useState("");

  const excludes = useMemo(
    () =>
      excludeText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    [excludeText],
  );
  const working: Rule = useMemo(() => ({ ...draft, exclude: excludes }), [draft, excludes]);

  const errors: string[] = [];
  if (!working.include.trim()) errors.push("Include pattern is required.");
  if (!working.redirectTo.trim()) errors.push("Redirect target is required.");
  if (working.matchType === "regex") {
    if (working.include && !isValidRegexSource(working.include))
      errors.push("Include pattern is not a valid regular expression.");
    for (const e of working.exclude)
      if (!isValidRegexSource(e)) errors.push(`Exclude "${e}" is not a valid regular expression.`);
  }

  const jsReason = errors.length === 0 ? dnrIneligibilityReason(working) : null;

  const thisResult = testInput ? matchRuleDetailed(testInput, { ...working, enabled: true }) : null;
  const firstFiring = useMemo(() => {
    if (!testInput) return null;
    const others = allRules.map((r) => (r.id === working.id ? working : r));
    if (!others.some((r) => r.id === working.id)) others.push(working);
    return testUrl(testInput, others);
  }, [testInput, allRules, working]);

  const set = <K extends keyof Rule>(key: K, value: Rule[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const toggleInList = <T extends string>(list: T[], item: T): T[] =>
    list.includes(item) ? list.filter((x) => x !== item) : [...list, item];

  return (
    <form
      className="rr-stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (errors.length === 0) onSave(working);
      }}
    >
      <div className="rr-field">
        <label htmlFor="rule-name">Name</label>
        <input
          id="rule-name"
          className="rr-input"
          value={draft.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="Optional description"
        />
      </div>

      <div className="rr-grid-2">
        <div className="rr-field">
          <label htmlFor="rule-matchType">Pattern type</label>
          <select
            id="rule-matchType"
            className="rr-select"
            value={draft.matchType}
            onChange={(e) => set("matchType", e.target.value as Rule["matchType"])}
          >
            {MATCH_TYPES.map((t) => (
              <option key={t} value={t}>
                {t === "wildcard" ? "Wildcard (* captures)" : "Regular expression"}
              </option>
            ))}
          </select>
        </div>
        <div className="rr-field">
          <label htmlFor="rule-applyTo">Applies to</label>
          <select
            id="rule-applyTo"
            className="rr-select"
            value={draft.applyTo}
            onChange={(e) => set("applyTo", e.target.value as Rule["applyTo"])}
          >
            {APPLY_TO.map((t) => (
              <option key={t} value={t}>
                {t === "navigation"
                  ? "Page navigations (incl. SPA history)"
                  : "Selected request types"}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="rr-field">
        <label htmlFor="rule-include">Include pattern</label>
        <input
          id="rule-include"
          className="rr-input rr-input--mono"
          value={draft.include}
          onChange={(e) => set("include", e.target.value)}
          placeholder={
            draft.matchType === "wildcard"
              ? "https://old.example/*"
              : "^https?://(?:www\\.)?example\\.com/(.*)$"
          }
          spellCheck={false}
          required
        />
        <div className="rr-help">
          {draft.matchType === "wildcard"
            ? "Each * becomes a capture group ($1, $2, ...). Matching is case-insensitive."
            : "JavaScript regex, matched anywhere in the URL, case-insensitive. Use ^ and $ to anchor."}
        </div>
      </div>

      <div className="rr-field">
        <label htmlFor="rule-redirectTo">Redirect to</label>
        <input
          id="rule-redirectTo"
          className="rr-input rr-input--mono"
          value={draft.redirectTo}
          onChange={(e) => set("redirectTo", e.target.value)}
          placeholder="https://new.example/$1"
          spellCheck={false}
          required
        />
      </div>

      <div className="rr-field">
        <label htmlFor="rule-exclude">Exclude patterns (one per line)</label>
        <textarea
          id="rule-exclude"
          className="rr-textarea rr-textarea--mono"
          value={excludeText}
          onChange={(e) => setExcludeText(e.target.value)}
          rows={2}
          spellCheck={false}
        />
      </div>

      <fieldset className="rr-field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="rr-field__label">Transforms (applied to each capture, in order)</legend>
        <div className="rr-checks">
          {TRANSFORMS.map((t) => (
            <label key={t} className="rr-check">
              <input
                type="checkbox"
                checked={draft.transforms.includes(t)}
                onChange={() => set("transforms", toggleInList(draft.transforms, t))}
              />
              {TRANSFORM_LABELS[t]}
            </label>
          ))}
        </div>
      </fieldset>

      {draft.applyTo === "all" ? (
        <fieldset className="rr-field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="rr-field__label">Request types (none selected = every type)</legend>
          <div className="rr-checks">
            {RESOURCE_TYPES.map((t: ResourceType) => (
              <label key={t} className="rr-check">
                <input
                  type="checkbox"
                  checked={draft.resourceTypes.includes(t)}
                  onChange={() => set("resourceTypes", toggleInList(draft.resourceTypes, t))}
                />
                {t}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      {errors.length > 0 ? (
        <div className="rr-notice rr-notice--error" role="alert">
          <ul className="rr-list">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="rr-help">
          {jsReason
            ? `Runs through the JavaScript fallback (${jsReason}). Only page navigations can be redirected this way.`
            : "Compiles to a declarativeNetRequest rule: redirects happen in the network layer."}
        </div>
      )}

      <div className="rr-field">
        <label htmlFor="rule-test">Live tester</label>
        <input
          id="rule-test"
          className="rr-input rr-input--mono"
          value={testInput}
          onChange={(e) => setTestInput(e.target.value)}
          placeholder="Paste a URL to see what this rule does"
          spellCheck={false}
        />
        {testInput ? (
          <div className={`rr-result ${thisResult ? "rr-result--hit" : ""}`}>
            {thisResult ? (
              <>
                <div>
                  This rule redirects to <span className="rr-mono">{thisResult.target}</span>
                </div>
                {thisResult.groups.length > 0 ? (
                  <div className="rr-small rr-muted">
                    Captures:{" "}
                    {thisResult.groups.map((g, i) => (
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
            <div className="rr-small rr-muted">
              {firstFiring
                ? firstFiring.rule.id === working.id
                  ? "It is the first rule to fire for this URL."
                  : `Another rule fires first: "${firstFiring.rule.name || firstFiring.rule.include}" -> ${firstFiring.target}`
                : "No enabled rule fires for this URL."}
            </div>
          </div>
        ) : null}
      </div>

      <div className="rr-row">
        <Button type="submit" disabled={errors.length > 0}>
          Save rule
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

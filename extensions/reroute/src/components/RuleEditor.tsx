import { Button } from "@browserforge/ui";
import { useMemo, useState } from "react";
import { dnrIneligibilityReason } from "../lib/rules/dnr-compiler";
import {
  APPLY_TO,
  MATCH_TYPES,
  RESOURCE_TYPES,
  TRANSFORMS,
  type ResourceType,
  type Rule,
  type Transform,
} from "../lib/rules/model";
import { parseExcludeLines, validateRuleDraft } from "../lib/rules/validate";
import { RuleTester } from "./RuleTester";

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

const MATCH_TYPE_LABELS = {
  wildcard: "Wildcard (* captures)",
  regex: "Regular expression",
} as const;

const APPLY_TO_LABELS = {
  navigation: "Page navigations (incl. SPA history)",
  all: "Selected request types",
} as const;

const INCLUDE_HELP = {
  wildcard: "Each * becomes a capture group ($1, $2, ...). Matching is case-insensitive.",
  regex: "JavaScript regex, matched anywhere in the URL, case-insensitive. Use ^ and $ to anchor.",
} as const;

const INCLUDE_PLACEHOLDER = {
  wildcard: "https://old.example/*",
  regex: "^https?://(?:www\\.)?example\\.com/(.*)$",
} as const;

const toggleInList = <T extends string>(list: T[], item: T): T[] =>
  list.includes(item) ? list.filter((x) => x !== item) : [...list, item];

/** The draft under edit; `working` is the draft with the exclude text parsed into patterns. */
function useRuleDraft(initial: Rule) {
  const [draft, setDraft] = useState<Rule>(initial);
  const [excludeText, setExcludeText] = useState(initial.exclude.join("\n"));
  const working = useMemo(
    () => ({ ...draft, exclude: parseExcludeLines(excludeText) }),
    [draft, excludeText],
  );
  const set = <K extends keyof Rule>(key: K, value: Rule[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  return { draft, working, set, excludeText, setExcludeText };
}

function CheckboxGroup<T extends string>({
  legend,
  options,
  selected,
  labelOf,
  onToggle,
}: {
  legend: string;
  options: readonly T[];
  selected: T[];
  labelOf: (option: T) => string;
  onToggle: (option: T) => void;
}) {
  return (
    <fieldset className="rr-field" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="rr-field__label">{legend}</legend>
      <div className="rr-checks">
        {options.map((option) => (
          <label key={option} className="rr-check">
            <input
              type="checkbox"
              checked={selected.includes(option)}
              onChange={() => onToggle(option)}
            />
            {labelOf(option)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ValidationNotice({ errors, rule }: { errors: string[]; rule: Rule }) {
  if (errors.length > 0) {
    return (
      <div className="rr-notice rr-notice--error" role="alert">
        <ul className="rr-list">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </div>
    );
  }
  const jsReason = dnrIneligibilityReason(rule);
  return (
    <div className="rr-help">
      {jsReason
        ? `Runs through the JavaScript fallback (${jsReason}). Only page navigations can be redirected this way.`
        : "Compiles to a declarativeNetRequest rule: redirects happen in the network layer."}
    </div>
  );
}

export function RuleEditor({ rule, allRules, onSave, onCancel }: RuleEditorProps) {
  const { draft, working, set, excludeText, setExcludeText } = useRuleDraft(rule);
  const [testUrl, setTestUrl] = useState("");
  const errors = validateRuleDraft(working);

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
                {MATCH_TYPE_LABELS[t]}
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
                {APPLY_TO_LABELS[t]}
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
          placeholder={INCLUDE_PLACEHOLDER[draft.matchType]}
          spellCheck={false}
          required
        />
        <div className="rr-help">{INCLUDE_HELP[draft.matchType]}</div>
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

      <CheckboxGroup
        legend="Transforms (applied to each capture, in order)"
        options={TRANSFORMS}
        selected={draft.transforms}
        labelOf={(t) => TRANSFORM_LABELS[t]}
        onToggle={(t) => set("transforms", toggleInList(draft.transforms, t))}
      />

      {draft.applyTo === "all" ? (
        <CheckboxGroup
          legend="Request types (none selected = every type)"
          options={RESOURCE_TYPES}
          selected={draft.resourceTypes}
          labelOf={(t: ResourceType) => t}
          onToggle={(t) => set("resourceTypes", toggleInList(draft.resourceTypes, t))}
        />
      ) : null}

      <ValidationNotice errors={errors} rule={working} />

      <RuleTester rule={working} allRules={allRules} url={testUrl} onUrlChange={setTestUrl} />

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

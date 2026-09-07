import { Button } from "@browserforge/ui";
import { useState, type DragEvent } from "react";
import { describeRule, type Rule } from "../lib/rules/model";
import { Toggle } from "./Toggle";

export interface RuleListProps {
  rules: Rule[];
  jsOnlyReasons: Record<string, string>;
  onChange: (rules: Rule[]) => void;
  onEdit: (rule: Rule) => void;
}

function move<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item === undefined) return [...list];
  next.splice(to, 0, item);
  return next;
}

export function RuleList({ rules, jsOnlyReasons, onChange, onEdit }: RuleListProps) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  if (rules.length === 0) {
    return (
      <p className="rr-muted">
        No rules yet. Add one, import a Redirector export, or install a rule pack.
      </p>
    );
  }

  const update = (id: string, patch: Partial<Rule>) =>
    onChange(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const remove = (id: string) => {
    const rule = rules.find((r) => r.id === id);
    if (rule && !window.confirm(`Delete rule "${describeRule(rule)}"?`)) return;
    onChange(rules.filter((r) => r.id !== id));
  };

  const onDragStart = (index: number) => (e: DragEvent<HTMLLIElement>) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));
  };
  const onDragOver = (index: number) => (e: DragEvent<HTMLLIElement>) => {
    e.preventDefault();
    if (overIndex !== index) setOverIndex(index);
  };
  const onDrop = (index: number) => (e: DragEvent<HTMLLIElement>) => {
    e.preventDefault();
    const from = dragIndex ?? Number(e.dataTransfer.getData("text/plain"));
    setDragIndex(null);
    setOverIndex(null);
    if (Number.isNaN(from) || from === index) return;
    onChange(move(rules, from, index));
  };
  const onDragEnd = () => {
    setDragIndex(null);
    setOverIndex(null);
  };

  return (
    <ol className="rr-rules" aria-label="Rules, first match wins">
      {rules.map((rule, index) => {
        const jsReason = jsOnlyReasons[rule.id];
        const classes = [
          "rr-rule",
          rule.enabled ? "" : "rr-rule--disabled",
          dragIndex === index ? "rr-rule--dragging" : "",
          overIndex === index && dragIndex !== index ? "rr-rule--over" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <li
            key={rule.id}
            className={classes}
            draggable
            onDragStart={onDragStart(index)}
            onDragOver={onDragOver(index)}
            onDrop={onDrop(index)}
            onDragEnd={onDragEnd}
          >
            <span className="rr-rule__handle" title="Drag to reorder" aria-hidden="true">
              ::
            </span>
            <Toggle
              checked={rule.enabled}
              onChange={(enabled) => update(rule.id, { enabled })}
              title={rule.enabled ? "Disable rule" : "Enable rule"}
            />
            <div className="rr-rule__body">
              <div className="rr-rule__title">
                {describeRule(rule)} <span className="rr-tag">{rule.matchType}</span>{" "}
                {rule.applyTo === "all" ? <span className="rr-tag">all requests</span> : null}{" "}
                {jsReason ? (
                  <span className="rr-tag rr-tag--accent" title={`JS fallback: ${jsReason}`}>
                    JS
                  </span>
                ) : rule.enabled ? (
                  <span className="rr-tag" title="Handled by declarativeNetRequest">
                    DNR
                  </span>
                ) : null}
              </div>
              <div
                className="rr-rule__meta rr-mono"
                title={`${rule.include} -> ${rule.redirectTo}`}
              >
                {rule.include} {"->"} {rule.redirectTo}
              </div>
            </div>
            <div className="rr-rule__actions">
              <Button
                variant="ghost"
                size="sm"
                aria-label="Move up"
                disabled={index === 0}
                onClick={() => onChange(move(rules, index, index - 1))}
              >
                Up
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Move down"
                disabled={index === rules.length - 1}
                onClick={() => onChange(move(rules, index, index + 1))}
              >
                Down
              </Button>
              <Button variant="secondary" size="sm" onClick={() => onEdit(rule)}>
                Edit
              </Button>
              <Button variant="ghost" size="sm" onClick={() => remove(rule.id)}>
                Delete
              </Button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

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

/** Drag-and-drop reordering state for a list of `<li draggable>` rows. */
function useDragReorder(onMove: (from: number, to: number) => void) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const reset = () => {
    setDragIndex(null);
    setOverIndex(null);
  };
  const handlersFor = (index: number) => ({
    onDragStart: (e: DragEvent<HTMLLIElement>) => {
      setDragIndex(index);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(index));
    },
    onDragOver: (e: DragEvent<HTMLLIElement>) => {
      e.preventDefault();
      if (overIndex !== index) setOverIndex(index);
    },
    onDrop: (e: DragEvent<HTMLLIElement>) => {
      e.preventDefault();
      const from = dragIndex ?? Number(e.dataTransfer.getData("text/plain"));
      reset();
      if (!Number.isNaN(from) && from !== index) onMove(from, index);
    },
    onDragEnd: reset,
  });
  const classFor = (index: number) =>
    [
      dragIndex === index ? "rr-rule--dragging" : "",
      overIndex === index && dragIndex !== index ? "rr-rule--over" : "",
    ]
      .filter(Boolean)
      .join(" ");
  return { handlersFor, classFor };
}

function EngineTag({ rule, jsReason }: { rule: Rule; jsReason: string | undefined }) {
  if (jsReason) {
    return (
      <span className="rr-tag rr-tag--accent" title={`JS fallback: ${jsReason}`}>
        JS
      </span>
    );
  }
  if (!rule.enabled) return null;
  return (
    <span className="rr-tag" title="Handled by declarativeNetRequest">
      DNR
    </span>
  );
}

interface RuleRowProps {
  rule: Rule;
  jsReason: string | undefined;
  isFirst: boolean;
  isLast: boolean;
  onToggle: (enabled: boolean) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function RuleRow(props: RuleRowProps) {
  const { rule, jsReason } = props;
  return (
    <>
      <span className="rr-rule__handle" title="Drag to reorder" aria-hidden="true">
        ::
      </span>
      <Toggle
        checked={rule.enabled}
        onChange={props.onToggle}
        title={rule.enabled ? "Disable rule" : "Enable rule"}
      />
      <div className="rr-rule__body">
        <div className="rr-rule__title">
          {describeRule(rule)} <span className="rr-tag">{rule.matchType}</span>{" "}
          {rule.applyTo === "all" ? <span className="rr-tag">all requests</span> : null}{" "}
          <EngineTag rule={rule} jsReason={jsReason} />
        </div>
        <div className="rr-rule__meta rr-mono" title={`${rule.include} -> ${rule.redirectTo}`}>
          {rule.include} {"->"} {rule.redirectTo}
        </div>
      </div>
      <div className="rr-rule__actions">
        <Button
          variant="ghost"
          size="sm"
          aria-label="Move up"
          disabled={props.isFirst}
          onClick={props.onMoveUp}
        >
          Up
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Move down"
          disabled={props.isLast}
          onClick={props.onMoveDown}
        >
          Down
        </Button>
        <Button variant="secondary" size="sm" onClick={props.onEdit}>
          Edit
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onDelete}>
          Delete
        </Button>
      </div>
    </>
  );
}

export function RuleList({ rules, jsOnlyReasons, onChange, onEdit }: RuleListProps) {
  const reorder = (from: number, to: number) => onChange(move(rules, from, to));
  const drag = useDragReorder(reorder);

  if (rules.length === 0) {
    return (
      <p className="rr-muted">
        No rules yet. Add one, import a Redirector export, or install a rule pack.
      </p>
    );
  }

  const setEnabled = (id: string, enabled: boolean) =>
    onChange(rules.map((r) => (r.id === id ? { ...r, enabled } : r)));

  const remove = (rule: Rule) => {
    if (!window.confirm(`Delete rule "${describeRule(rule)}"?`)) return;
    onChange(rules.filter((r) => r.id !== rule.id));
  };

  return (
    <ol className="rr-rules" aria-label="Rules, first match wins">
      {rules.map((rule, index) => (
        <li
          key={rule.id}
          className={["rr-rule", rule.enabled ? "" : "rr-rule--disabled", drag.classFor(index)]
            .filter(Boolean)
            .join(" ")}
          draggable
          {...drag.handlersFor(index)}
        >
          <RuleRow
            rule={rule}
            jsReason={jsOnlyReasons[rule.id]}
            isFirst={index === 0}
            isLast={index === rules.length - 1}
            onToggle={(enabled) => setEnabled(rule.id, enabled)}
            onMoveUp={() => reorder(index, index - 1)}
            onMoveDown={() => reorder(index, index + 1)}
            onEdit={() => onEdit(rule)}
            onDelete={() => remove(rule)}
          />
        </li>
      ))}
    </ol>
  );
}

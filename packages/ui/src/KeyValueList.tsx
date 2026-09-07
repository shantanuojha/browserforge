import type { ReactNode } from "react";
import { cx } from "./classNames.js";

export interface KeyValueItem {
  key: ReactNode;
  value: ReactNode;
  /** Render the value in the monospace font (ids, keys, URLs). */
  mono?: boolean;
}

export interface KeyValueListProps {
  items: readonly KeyValueItem[];
  className?: string;
}

/** Two-column definition list that stacks to one column in narrow popups. */
export function KeyValueList({ items, className }: KeyValueListProps) {
  return (
    <dl className={cx("bf-kv", className)}>
      {items.map((item, index) => (
        <div className="bf-kv__row" key={index}>
          <dt className="bf-kv__key">{item.key}</dt>
          <dd className={cx("bf-kv__value", item.mono && "bf-kv__value--mono")}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

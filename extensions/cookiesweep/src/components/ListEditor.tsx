import { useMemo, useState, type FormEvent } from "react";
import { Button } from "@browserforge/ui";
import {
  addListEntry,
  isValidPattern,
  normalizePattern,
  removeListEntry,
  type ListEntry,
  type ListType,
} from "../lib/settings.js";
import { listTypeLabel, StatusPill } from "./StatusPill.js";

export interface ListEditorProps {
  lists: readonly ListEntry[];
  /** Cookie store ids known to the browser, for the optional per-store selector. */
  stores: readonly string[];
  onChange: (next: ListEntry[]) => void | Promise<void>;
}

type Filter = "all" | ListType;

export function ListEditor({ lists, stores, onChange }: ListEditorProps) {
  const [pattern, setPattern] = useState("");
  const [listType, setListType] = useState<ListType>("white");
  const [storeId, setStoreId] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(() => {
    const filtered = filter === "all" ? [...lists] : lists.filter((e) => e.listType === filter);
    return filtered.sort((a, b) => {
      const pa = a.pattern.replace(/^\*\.?/, "");
      const pb = b.pattern.replace(/^\*\.?/, "");
      return pa.localeCompare(pb) || a.pattern.localeCompare(b.pattern);
    });
  }, [lists, filter]);

  const counts = useMemo(
    () => ({
      white: lists.filter((e) => e.listType === "white").length,
      grey: lists.filter((e) => e.listType === "grey").length,
    }),
    [lists],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = pattern.trim();
    if (!trimmed) return;
    if (!isValidPattern(trimmed)) {
      setError(
        "Use a hostname such as example.com, *.example.com (subdomains only) or *example.com (site and subdomains).",
      );
      return;
    }
    setError(null);
    const entry: ListEntry = { pattern: normalizePattern(trimmed), listType };
    if (storeId) entry.storeId = storeId;
    await onChange(addListEntry(lists, entry));
    setPattern("");
  };

  const setType = async (entry: ListEntry, next: ListType) => {
    if (entry.listType === next) return;
    await onChange(addListEntry(lists, { ...entry, listType: next }));
  };

  const remove = async (entry: ListEntry) => {
    await onChange(removeListEntry(lists, entry));
  };

  const storeOptions = useMemo(() => {
    const known = new Set(stores);
    for (const entry of lists) if (entry.storeId) known.add(entry.storeId);
    return [...known].sort();
  }, [stores, lists]);

  return (
    <div className="cs-stack">
      <form className="cs-row" onSubmit={submit}>
        <input
          className="cs-input cs-input--grow"
          type="text"
          placeholder="example.com or *example.com"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          aria-label="Host pattern"
          autoComplete="off"
          spellCheck={false}
        />
        <select
          className="cs-select"
          value={listType}
          onChange={(e) => setListType(e.target.value as ListType)}
          aria-label="List type"
        >
          <option value="white">Whitelist (always keep)</option>
          <option value="grey">Greylist (keep until restart)</option>
        </select>
        {storeOptions.length > 1 ? (
          <select
            className="cs-select"
            value={storeId}
            onChange={(e) => setStoreId(e.target.value)}
            aria-label="Cookie store"
          >
            <option value="">All cookie stores</option>
            {storeOptions.map((id) => (
              <option key={id} value={id}>
                Store {id}
              </option>
            ))}
          </select>
        ) : null}
        <Button type="submit" disabled={!pattern.trim()}>
          Add
        </Button>
      </form>
      {error ? (
        <div className="cs-callout cs-callout--error" role="alert">
          {error}
        </div>
      ) : null}
      <p className="cs-small cs-muted" style={{ margin: 0 }}>
        <code className="cs-mono">example.com</code> matches that exact cookie domain,{" "}
        <code className="cs-mono">*.example.com</code> matches subdomains only, and{" "}
        <code className="cs-mono">*example.com</code> matches the site and every subdomain.
        Whitelist wins when a domain is on both lists.
      </p>

      <div className="cs-row" role="group" aria-label="Filter">
        <Button
          size="sm"
          variant={filter === "all" ? "primary" : "secondary"}
          onClick={() => setFilter("all")}
        >
          All ({lists.length})
        </Button>
        <Button
          size="sm"
          variant={filter === "white" ? "primary" : "secondary"}
          onClick={() => setFilter("white")}
        >
          Whitelist ({counts.white})
        </Button>
        <Button
          size="sm"
          variant={filter === "grey" ? "primary" : "secondary"}
          onClick={() => setFilter("grey")}
        >
          Greylist ({counts.grey})
        </Button>
      </div>

      {visible.length === 0 ? (
        <div className="cs-empty">
          No entries yet. Sites you add here keep their cookies when their tabs close.
        </div>
      ) : (
        <div className="cs-table-wrap cs-table--scroll">
          <table className="cs-table">
            <thead>
              <tr>
                <th scope="col">Pattern</th>
                <th scope="col">List</th>
                <th scope="col">Store</th>
                <th scope="col">
                  <span className="cs-nowrap">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((entry) => (
                <tr key={`${entry.storeId ?? "*"}|${entry.pattern}`}>
                  <td className="cs-mono">{entry.pattern}</td>
                  <td>
                    <StatusPill status={entry.listType} label={listTypeLabel(entry.listType)} />
                  </td>
                  <td className="cs-muted">{entry.storeId ?? "All"}</td>
                  <td className="cs-table__actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setType(entry, entry.listType === "white" ? "grey" : "white")}
                    >
                      {entry.listType === "white" ? "Move to greylist" : "Move to whitelist"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(entry)}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

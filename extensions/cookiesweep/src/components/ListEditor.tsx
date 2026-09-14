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

const PATTERN_HELP =
  "Use a hostname such as example.com, *.example.com (subdomains only) or *example.com (site and subdomains).";

/** Sort by the host part so `*.b.com`, `a.com` and `*c.com` read alphabetically. */
function sortByHost(entries: readonly ListEntry[]): ListEntry[] {
  const hostOf = (pattern: string) => pattern.replace(/^\*\.?/, "");
  return [...entries].sort(
    (a, b) =>
      hostOf(a.pattern).localeCompare(hostOf(b.pattern)) || a.pattern.localeCompare(b.pattern),
  );
}

const otherList = (type: ListType): ListType => (type === "white" ? "grey" : "white");

interface AddEntryFormProps {
  storeOptions: readonly string[];
  onAdd: (entry: ListEntry) => Promise<void>;
}

function AddEntryForm({ storeOptions, onAdd }: AddEntryFormProps) {
  const [pattern, setPattern] = useState("");
  const [listType, setListType] = useState<ListType>("white");
  const [storeId, setStoreId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = pattern.trim();
    if (!trimmed) return;
    if (!isValidPattern(trimmed)) {
      setError(PATTERN_HELP);
      return;
    }
    setError(null);
    const entry: ListEntry = { pattern: normalizePattern(trimmed), listType };
    if (storeId) entry.storeId = storeId;
    await onAdd(entry);
    setPattern("");
  };

  return (
    <>
      <form className="cs-row" onSubmit={(event) => void submit(event)}>
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
    </>
  );
}

interface FilterBarProps {
  filter: Filter;
  counts: { all: number; white: number; grey: number };
  onChange: (filter: Filter) => void;
}

function FilterBar({ filter, counts, onChange }: FilterBarProps) {
  const options: { id: Filter; label: string }[] = [
    { id: "all", label: `All (${counts.all})` },
    { id: "white", label: `Whitelist (${counts.white})` },
    { id: "grey", label: `Greylist (${counts.grey})` },
  ];
  return (
    <div className="cs-row" role="group" aria-label="Filter">
      {options.map((option) => (
        <Button
          key={option.id}
          size="sm"
          variant={filter === option.id ? "primary" : "secondary"}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

interface EntryTableProps {
  entries: readonly ListEntry[];
  onMove: (entry: ListEntry, to: ListType) => void;
  onRemove: (entry: ListEntry) => void;
}

function EntryTable({ entries, onMove, onRemove }: EntryTableProps) {
  if (entries.length === 0) {
    return (
      <div className="cs-empty">
        No entries yet. Sites you add here keep their cookies when their tabs close.
      </div>
    );
  }
  return (
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
          {entries.map((entry) => (
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
                  onClick={() => onMove(entry, otherList(entry.listType))}
                >
                  Move to {listTypeLabel(otherList(entry.listType)).toLowerCase()}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onRemove(entry)}>
                  Remove
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ListEditor({ lists, stores, onChange }: ListEditorProps) {
  const [filter, setFilter] = useState<Filter>("all");

  const visible = useMemo(
    () => sortByHost(filter === "all" ? lists : lists.filter((e) => e.listType === filter)),
    [lists, filter],
  );
  const counts = useMemo(
    () => ({
      all: lists.length,
      white: lists.filter((e) => e.listType === "white").length,
      grey: lists.filter((e) => e.listType === "grey").length,
    }),
    [lists],
  );
  const storeOptions = useMemo(() => {
    const known = new Set(stores);
    for (const entry of lists) if (entry.storeId) known.add(entry.storeId);
    return [...known].sort();
  }, [stores, lists]);

  return (
    <div className="cs-stack">
      <AddEntryForm
        storeOptions={storeOptions}
        onAdd={async (entry) => {
          await onChange(addListEntry(lists, entry));
        }}
      />
      <p className="cs-small cs-muted" style={{ margin: 0 }}>
        <code className="cs-mono">example.com</code> matches that exact cookie domain,{" "}
        <code className="cs-mono">*.example.com</code> matches subdomains only, and{" "}
        <code className="cs-mono">*example.com</code> matches the site and every subdomain.
        Whitelist wins when a domain is on both lists.
      </p>
      <FilterBar filter={filter} counts={counts} onChange={setFilter} />
      <EntryTable
        entries={visible}
        onMove={(entry, to) => void onChange(addListEntry(lists, { ...entry, listType: to }))}
        onRemove={(entry) => void onChange(removeListEntry(lists, entry))}
      />
    </div>
  );
}

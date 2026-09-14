import { useRef, useState, type ChangeEvent } from "react";
import { Button, dateStamp, downloadTextFile } from "@browserforge/ui";
import {
  mergeLists,
  parseImport,
  serializeExport,
  type ImportFormat,
  type ImportResult,
} from "../lib/importer.js";
import type { ListEntry } from "../lib/settings.js";
import { listTypeLabel, StatusPill } from "./StatusPill.js";

export interface ImportExportProps {
  lists: readonly ListEntry[];
  onReplace: (next: ListEntry[]) => void | Promise<void>;
}

const PREVIEW_LIMIT = 200;
const SKIPPED_SHOWN = 10;

const FORMAT_LABELS: Record<ImportFormat, string> = {
  "cookie-autodelete": "Cookie AutoDelete export",
  cookiesweep: "CookieSweep export",
  unknown: "Unknown format",
};

function SkippedList({ skipped }: { skipped: ImportResult["skipped"] }) {
  if (skipped.length === 0) return null;
  return (
    <div className="cs-callout cs-callout--error">
      Skipped entries:
      <ul>
        {skipped.slice(0, SKIPPED_SHOWN).map((s) => (
          <li key={`${s.index}-${s.reason}`}>
            #{s.index + 1}: {s.reason}
          </li>
        ))}
        {skipped.length > SKIPPED_SHOWN ? <li>and {skipped.length - SKIPPED_SHOWN} more</li> : null}
      </ul>
    </div>
  );
}

function PreviewTable({ entries }: { entries: ListEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="cs-table-wrap cs-table--scroll">
      <table className="cs-table">
        <thead>
          <tr>
            <th scope="col">Pattern</th>
            <th scope="col">List</th>
            <th scope="col">Store</th>
          </tr>
        </thead>
        <tbody>
          {entries.slice(0, PREVIEW_LIMIT).map((entry) => (
            <tr key={`${entry.storeId ?? "*"}|${entry.pattern}`}>
              <td className="cs-mono">{entry.pattern}</td>
              <td>
                <StatusPill status={entry.listType} label={listTypeLabel(entry.listType)} />
              </td>
              <td className="cs-muted">{entry.storeId ?? "All"}</td>
            </tr>
          ))}
          {entries.length > PREVIEW_LIMIT ? (
            <tr>
              <td colSpan={3} className="cs-muted">
                and {entries.length - PREVIEW_LIMIT} more
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function ImportPreview({
  preview,
  onApply,
  onCancel,
}: {
  preview: ImportResult;
  onApply: (mode: "merge" | "replace") => void;
  onCancel: () => void;
}) {
  return (
    <div className="cs-stack">
      <div className="cs-callout">
        Detected: <strong>{FORMAT_LABELS[preview.format]}</strong>. {preview.entries.length} entries
        ready, {preview.skipped.length} skipped.
      </div>
      {preview.warnings.length > 0 ? (
        <div className="cs-callout cs-callout--warn">
          <ul>
            {preview.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <SkippedList skipped={preview.skipped} />
      <PreviewTable entries={preview.entries} />
      <div className="cs-row">
        <Button onClick={() => onApply("merge")} disabled={preview.entries.length === 0}>
          Merge into my lists
        </Button>
        <Button
          variant="secondary"
          onClick={() => onApply("replace")}
          disabled={preview.entries.length === 0}
        >
          Replace my lists
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function ImportExport({ lists, onReplace }: ImportExportProps) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const runPreview = (source: string) => {
    setDone(null);
    setPreview(parseImport(source));
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    setText(content);
    runPreview(content);
    event.target.value = "";
  };

  const apply = async (mode: "merge" | "replace") => {
    if (!preview) return;
    const next = mode === "merge" ? mergeLists(lists, preview.entries) : [...preview.entries];
    await onReplace(next);
    setDone(
      mode === "merge"
        ? `Merged ${preview.entries.length} entries into your lists.`
        : `Replaced your lists with ${preview.entries.length} imported entries.`,
    );
    setPreview(null);
    setText("");
  };

  const exportJson = () =>
    downloadTextFile(`cookiesweep-lists-${dateStamp()}.json`, serializeExport(lists));

  return (
    <div className="cs-stack">
      <p className="cs-small cs-muted" style={{ margin: 0 }}>
        Paste the JSON from Cookie AutoDelete (Settings, Export expressions) or a CookieSweep
        export, or pick the file. Nothing is applied until you confirm the preview.
      </p>
      <textarea
        className="cs-textarea"
        placeholder='[{"expression": "*.example.com", "listType": "WHITE", "storeId": "default"}]'
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Import JSON"
        spellCheck={false}
      />
      <div className="cs-row">
        <Button variant="secondary" onClick={() => runPreview(text)} disabled={!text.trim()}>
          Preview import
        </Button>
        <Button variant="secondary" onClick={() => fileInput.current?.click()}>
          Choose file
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={onFile}
          aria-label="Import file"
        />
        <span style={{ flex: 1 }} />
        <Button variant="secondary" onClick={exportJson} disabled={lists.length === 0}>
          Export my lists
        </Button>
      </div>

      {done ? <div className="cs-callout">{done}</div> : null}

      {preview ? (
        <ImportPreview
          preview={preview}
          onApply={(mode) => void apply(mode)}
          onCancel={() => setPreview(null)}
        />
      ) : null}
    </div>
  );
}

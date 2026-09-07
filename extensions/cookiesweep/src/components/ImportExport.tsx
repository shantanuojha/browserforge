import { useRef, useState, type ChangeEvent } from "react";
import { Button } from "@browserforge/ui";
import { mergeLists, parseImport, serializeExport, type ImportResult } from "../lib/importer.js";
import type { ListEntry } from "../lib/settings.js";
import { listTypeLabel, StatusPill } from "./StatusPill.js";

export interface ImportExportProps {
  lists: readonly ListEntry[];
  onReplace: (next: ListEntry[]) => void | Promise<void>;
}

const PREVIEW_LIMIT = 200;

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

  const exportJson = () => {
    const json = serializeExport(lists);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cookiesweep-lists-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const formatLabel =
    preview?.format === "cookie-autodelete"
      ? "Cookie AutoDelete export"
      : preview?.format === "cookiesweep"
        ? "CookieSweep export"
        : "Unknown format";

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
        <div className="cs-stack">
          <div className="cs-callout">
            Detected: <strong>{formatLabel}</strong>. {preview.entries.length} entries ready,{" "}
            {preview.skipped.length} skipped.
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
          {preview.skipped.length > 0 ? (
            <div className="cs-callout cs-callout--error">
              Skipped entries:
              <ul>
                {preview.skipped.slice(0, 10).map((s) => (
                  <li key={`${s.index}-${s.reason}`}>
                    #{s.index + 1}: {s.reason}
                  </li>
                ))}
                {preview.skipped.length > 10 ? (
                  <li>and {preview.skipped.length - 10} more</li>
                ) : null}
              </ul>
            </div>
          ) : null}
          {preview.entries.length > 0 ? (
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
                  {preview.entries.slice(0, PREVIEW_LIMIT).map((entry) => (
                    <tr key={`${entry.storeId ?? "*"}|${entry.pattern}`}>
                      <td className="cs-mono">{entry.pattern}</td>
                      <td>
                        <StatusPill status={entry.listType} label={listTypeLabel(entry.listType)} />
                      </td>
                      <td className="cs-muted">{entry.storeId ?? "All"}</td>
                    </tr>
                  ))}
                  {preview.entries.length > PREVIEW_LIMIT ? (
                    <tr>
                      <td colSpan={3} className="cs-muted">
                        and {preview.entries.length - PREVIEW_LIMIT} more
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : null}
          <div className="cs-row">
            <Button onClick={() => apply("merge")} disabled={preview.entries.length === 0}>
              Merge into my lists
            </Button>
            <Button
              variant="secondary"
              onClick={() => apply("replace")}
              disabled={preview.entries.length === 0}
            >
              Replace my lists
            </Button>
            <Button variant="ghost" onClick={() => setPreview(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

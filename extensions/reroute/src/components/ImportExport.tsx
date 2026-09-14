import { Button, copyToClipboard, dateStamp, downloadTextFile } from "@browserforge/ui";
import { useMemo, useState, type ChangeEvent } from "react";
import { analyseImportText, type ImportPreview } from "../lib/rules/import-analysis";
import { serializeRules, type Rule } from "../lib/rules/model";
import { encodeShareLink } from "../lib/rules/share";
import { UpsellRow } from "./UpsellRow";

export type ImportMode = "append" | "replace";

export interface ImportExportProps {
  rules: Rule[];
  pro: boolean | null;
  onImport: (rules: Rule[], mode: ImportMode) => void;
}

type Notify = (text: string) => void;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function ShareLinkField({ link, notify }: { link: string; notify: Notify }) {
  return (
    <div className="rr-field" style={{ marginTop: 12 }}>
      <label htmlFor="share-link">Share link (anyone can paste this into Reroute)</label>
      <textarea
        id="share-link"
        className="rr-textarea rr-textarea--mono"
        readOnly
        value={link}
        rows={3}
        onFocus={(e) => e.target.select()}
      />
      <div className="rr-row">
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void copyToClipboard(link).then((ok) =>
              notify(ok ? "Share link copied." : "Clipboard unavailable."),
            )
          }
        >
          Copy link
        </Button>
        <span className="rr-small rr-muted">{link.length.toLocaleString()} characters</span>
      </div>
    </div>
  );
}

function ExportSection({
  rules,
  pro,
  notify,
}: Pick<ImportExportProps, "rules" | "pro"> & { notify: Notify }) {
  const [shareLink, setShareLink] = useState<string | null>(null);
  const empty = rules.length === 0;
  return (
    <section className="rr-section">
      <h2>Export</h2>
      <div className="rr-row">
        <Button
          variant="secondary"
          onClick={() =>
            downloadTextFile(`reroute-rules-${dateStamp()}.json`, serializeRules(rules))
          }
          disabled={empty}
        >
          Download JSON
        </Button>
        <Button
          variant="secondary"
          onClick={() =>
            void copyToClipboard(serializeRules(rules)).then((ok) =>
              notify(ok ? "Rules copied to clipboard." : "Clipboard unavailable."),
            )
          }
          disabled={empty}
        >
          Copy JSON
        </Button>
        <Button
          variant="secondary"
          onClick={() => setShareLink(encodeShareLink(rules))}
          disabled={empty || pro !== true}
          title={pro ? "Encode all rules into a reroute:// link" : "Pro feature"}
        >
          Create share link
        </Button>
      </div>
      {pro === false ? (
        <div style={{ marginTop: 12 }}>
          <UpsellRow feature="Shareable rule links" />
        </div>
      ) : null}
      {shareLink ? <ShareLinkField link={shareLink} notify={notify} /> : null}
    </section>
  );
}

function MessageList({ items, tone }: { items: string[]; tone?: "error" }) {
  if (items.length === 0) return null;
  return (
    <div className={tone === "error" ? "rr-notice rr-notice--error" : "rr-notice"}>
      <ul className="rr-list">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function PreviewTable({ rules }: { rules: Rule[] }) {
  return (
    <table className="rr-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Type</th>
          <th>Include</th>
          <th>Redirect to</th>
          <th>Transforms</th>
          <th>Enabled</th>
        </tr>
      </thead>
      <tbody>
        {rules.map((r) => (
          <tr key={r.id}>
            <td>{r.name || <span className="rr-muted">(none)</span>}</td>
            <td>{r.matchType}</td>
            <td className="rr-mono">{r.include}</td>
            <td className="rr-mono">{r.redirectTo}</td>
            <td>{r.transforms.join(", ") || "-"}</td>
            <td>{r.enabled ? "yes" : "no"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ImportPreviewView({
  preview,
  onApply,
}: {
  preview: ImportPreview;
  onApply: (mode: ImportMode) => void;
}) {
  const count = preview.rules.length;
  return (
    <div className="rr-stack" style={{ marginTop: 12 }}>
      <div>
        Detected <strong>{preview.source}</strong>: {plural(count, "rule")}
        {preview.errors.length > 0 ? `, ${preview.errors.length} skipped` : ""}.
      </div>
      <MessageList items={preview.errors} tone="error" />
      <MessageList items={preview.warnings} />
      {count > 0 ? (
        <>
          <PreviewTable rules={preview.rules} />
          <div className="rr-row">
            <Button onClick={() => onApply("append")}>Add {plural(count, "rule")}</Button>
            <Button
              variant="secondary"
              onClick={() => {
                if (window.confirm("Replace all existing rules with the imported ones?"))
                  onApply("replace");
              }}
            >
              Replace all
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function ImportSection({
  onImport,
  notify,
}: Pick<ImportExportProps, "onImport"> & { notify: Notify }) {
  const [text, setText] = useState("");
  const preview = useMemo(() => analyseImportText(text), [text]);

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    void file.text().then(setText);
    e.target.value = "";
  };

  const apply = (mode: ImportMode) => {
    if (!preview) return;
    onImport(preview.rules, mode);
    setText("");
    const count = preview.rules.length;
    notify(
      mode === "append"
        ? `Imported ${count} rules.`
        : `Replaced rules with ${count} imported rules.`,
    );
  };

  return (
    <section className="rr-section">
      <h2>Import</h2>
      <p className="rr-help">
        Paste Reroute JSON, a Redirector export (includePattern / redirectUrl / patternType ...) or
        a reroute:// share link. Nothing is applied until you confirm the preview.
      </p>
      <div className="rr-field">
        <textarea
          className="rr-textarea rr-textarea--mono"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='{"createdBy":"Redirector v3.5.3","redirects":[...]}'
          spellCheck={false}
          aria-label="Import text"
        />
        <div className="rr-row">
          <label
            className="bf-button bf-button--secondary bf-button--sm"
            style={{ cursor: "pointer" }}
          >
            Choose file
            <input type="file" accept=".json,application/json,.txt" onChange={onFile} hidden />
          </label>
          {text ? (
            <Button size="sm" variant="ghost" onClick={() => setText("")}>
              Clear
            </Button>
          ) : null}
        </div>
      </div>
      {preview ? <ImportPreviewView preview={preview} onApply={apply} /> : null}
    </section>
  );
}

export function ImportExport({ rules, pro, onImport }: ImportExportProps) {
  const [status, setStatus] = useState<string | null>(null);
  return (
    <div className="rr-stack">
      <ExportSection rules={rules} pro={pro} notify={setStatus} />
      <ImportSection onImport={onImport} notify={setStatus} />
      {status ? (
        <div className="rr-notice" role="status">
          {status}
        </div>
      ) : null}
    </div>
  );
}

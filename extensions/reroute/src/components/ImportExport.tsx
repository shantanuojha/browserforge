import { Button } from "@browserforge/ui";
import { useMemo, useState, type ChangeEvent } from "react";
import { parseRules, serializeRules, type Rule } from "../lib/rules/model";
import { importRedirector, looksLikeRedirectorExport } from "../lib/rules/redirector-import";
import { decodeShareLink, encodeShareLink, isShareLink } from "../lib/rules/share";
import { UpsellRow } from "./UpsellRow";

export interface ImportExportProps {
  rules: Rule[];
  pro: boolean | null;
  onImport: (rules: Rule[], mode: "append" | "replace") => void;
}

interface Preview {
  source: string;
  rules: Rule[];
  warnings: string[];
  errors: string[];
}

function analyse(text: string): Preview | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (isShareLink(trimmed)) {
    const res = decodeShareLink(trimmed);
    return { source: "Reroute share link", rules: res.rules, warnings: [], errors: res.errors };
  }
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (e) {
    return {
      source: "unknown",
      rules: [],
      warnings: [],
      errors: [`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
  if (looksLikeRedirectorExport(json)) {
    const res = importRedirector(json);
    return {
      source: res.source,
      rules: res.items.map((i) => i.rule),
      warnings: res.items.flatMap((i, idx) =>
        i.warnings.map((w) => `${i.rule.name || `redirect ${idx + 1}`}: ${w}`),
      ),
      errors: res.errors,
    };
  }
  const res = parseRules(json);
  return { source: "Reroute JSON", rules: res.rules, warnings: [], errors: res.errors };
}

function download(filename: string, text: string, type = "application/json") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function ImportExport({ rules, pro, onImport }: ImportExportProps) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const preview = useMemo(() => analyse(text), [text]);

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    void file.text().then(setText);
    e.target.value = "";
  };

  const stamp = new Date().toISOString().slice(0, 10);

  return (
    <div className="rr-stack">
      <section className="rr-section">
        <h2>Export</h2>
        <div className="rr-row">
          <Button
            variant="secondary"
            onClick={() => download(`reroute-rules-${stamp}.json`, serializeRules(rules))}
            disabled={rules.length === 0}
          >
            Download JSON
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              void copy(serializeRules(rules)).then((ok) =>
                setStatus(ok ? "Rules copied to clipboard." : "Clipboard unavailable."),
              )
            }
            disabled={rules.length === 0}
          >
            Copy JSON
          </Button>
          <Button
            variant="secondary"
            onClick={() => setShareLink(encodeShareLink(rules))}
            disabled={rules.length === 0 || pro !== true}
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
        {shareLink ? (
          <div className="rr-field" style={{ marginTop: 12 }}>
            <label htmlFor="share-link">Share link (anyone can paste this into Reroute)</label>
            <textarea
              id="share-link"
              className="rr-textarea rr-textarea--mono"
              readOnly
              value={shareLink}
              rows={3}
              onFocus={(e) => e.target.select()}
            />
            <div className="rr-row">
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  void copy(shareLink).then((ok) =>
                    setStatus(ok ? "Share link copied." : "Clipboard unavailable."),
                  )
                }
              >
                Copy link
              </Button>
              <span className="rr-small rr-muted">
                {shareLink.length.toLocaleString()} characters
              </span>
            </div>
          </div>
        ) : null}
      </section>

      <section className="rr-section">
        <h2>Import</h2>
        <p className="rr-help">
          Paste Reroute JSON, a Redirector export (includePattern / redirectUrl / patternType ...)
          or a reroute:// share link. Nothing is applied until you confirm the preview.
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

        {preview ? (
          <div className="rr-stack" style={{ marginTop: 12 }}>
            <div>
              Detected <strong>{preview.source}</strong>: {preview.rules.length} rule
              {preview.rules.length === 1 ? "" : "s"}
              {preview.errors.length > 0 ? `, ${preview.errors.length} skipped` : ""}.
            </div>
            {preview.errors.length > 0 ? (
              <div className="rr-notice rr-notice--error">
                <ul className="rr-list">
                  {preview.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {preview.warnings.length > 0 ? (
              <div className="rr-notice">
                <ul className="rr-list">
                  {preview.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {preview.rules.length > 0 ? (
              <>
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
                    {preview.rules.map((r) => (
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
                <div className="rr-row">
                  <Button
                    onClick={() => {
                      onImport(preview.rules, "append");
                      setText("");
                      setStatus(`Imported ${preview.rules.length} rules.`);
                    }}
                  >
                    Add {preview.rules.length} rule{preview.rules.length === 1 ? "" : "s"}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      if (!window.confirm("Replace all existing rules with the imported ones?"))
                        return;
                      onImport(preview.rules, "replace");
                      setText("");
                      setStatus(`Replaced rules with ${preview.rules.length} imported rules.`);
                    }}
                  >
                    Replace all
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </section>

      {status ? (
        <div className="rr-notice" role="status">
          {status}
        </div>
      ) : null}
    </div>
  );
}

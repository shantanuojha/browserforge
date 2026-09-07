import { useRef, useState, type ChangeEvent } from "react";
import { Button } from "@browserforge/ui";
import { downloadJson, readFileText } from "@/lib/download";
import { exportFileName, isArborExport, parseArborExport } from "@/lib/io/arbor-json";
import { materialize, type ImportPreview } from "@/lib/io/imported";
import { parseTabsOutliner, TABS_OUTLINER_STORAGE_KEY } from "@/lib/io/tabs-outliner";
import { msg } from "@/lib/messages";
import { ConfirmDialog } from "./ConfirmDialog";
import { UpsellRow } from "./UpsellRow";

export interface ImportExportViewProps {
  pro: boolean | null;
  nodeCount: number;
}

interface Pending {
  preview: ImportPreview;
  /** Raw text kept so a "replace" import can be materialised at the root. */
  arborNative: boolean;
}

function PreviewCard({ preview }: { preview: ImportPreview }) {
  const c = preview.counts;
  return (
    <div className="preview">
      <div className="preview__counts">
        <span className="preview__count">{c.windows} windows</span>
        <span className="preview__count">{c.tabs} tabs</span>
        <span className="preview__count">{c.groups} groups</span>
        <span className="preview__count">{c.notes} notes</span>
        <span className="preview__count">{c.total} total</span>
      </div>
      {preview.sample.length ? (
        <ul className="preview__sample">
          {preview.sample.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
          {c.total > preview.sample.length ? (
            <li>and {c.total - preview.sample.length} more</li>
          ) : null}
        </ul>
      ) : null}
      {preview.warnings.length ? (
        <div className="notice notice--warn">
          <ul>
            {preview.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function ImportExportView({ pro, nodeCount }: ImportExportViewProps) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = (text: string) => {
    setError(null);
    setStatus(null);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      if (isArborExport(parsed)) {
        setPending({ preview: parseArborExport(parsed), arborNative: true });
      } else {
        setPending({ preview: parseTabsOutliner(parsed), arborNative: false });
      }
    } catch (e) {
      setPending(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      load(await readFileText(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      e.target.value = "";
    }
  };

  const doExport = async () => {
    setBusy(true);
    try {
      const data = await msg.exportTree.send();
      downloadJson(exportFileName(), data);
      setStatus(`Exported ${data.nodeCount} nodes.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const commit = async (mode: "merge" | "replace") => {
    if (!pending) return;
    setBusy(true);
    setConfirmReplace(false);
    try {
      const wrapTitle =
        mode === "replace"
          ? null
          : `Imported from ${pending.preview.source} (${new Date().toLocaleDateString()})`;
      const nodes = materialize(pending.preview.roots, { wrapTitle });
      const count = await msg.importNodes.send({ nodes, mode });
      setStatus(
        `Imported ${count} nodes${mode === "merge" ? " into a new group at the bottom of the tree" : ""}.`,
      );
      setPending(null);
      setPasted("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <section className="section">
        <div className="section__header">
          <h2 className="section__title">Export</h2>
        </div>
        <div className="section__body">
          <p>
            Save the whole tree ({nodeCount} nodes) as a JSON file you can re-import later or keep
            as a backup.
          </p>
          <div className="button-row">
            <Button size="sm" disabled={busy} onClick={() => void doExport()}>
              Export JSON
            </Button>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section__header">
          <h2 className="section__title">Import</h2>
        </div>
        <div className="section__body">
          <p>
            Accepts Arbor exports, Tabs Outliner tree files, and the raw{" "}
            <code>{TABS_OUTLINER_STORAGE_KEY}</code> value. Nothing is written until you review what
            was recognised and press Import.
          </p>
          <div className="button-row">
            <input
              ref={fileRef}
              type="file"
              accept=".json,.tree,.txt,application/json"
              hidden
              onChange={(e) => void onFile(e)}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              Choose file
            </Button>
            <span className="list__muted">or paste below</span>
          </div>
          <textarea
            className="textarea"
            value={pasted}
            placeholder="Paste JSON here"
            onChange={(e) => setPasted(e.target.value)}
            spellCheck={false}
          />
          <div className="button-row">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || !pasted.trim()}
              onClick={() => load(pasted)}
            >
              Analyse pasted text
            </Button>
          </div>
          {error ? <div className="notice notice--error">{error}</div> : null}
          {pending ? (
            <>
              <p>
                Recognised from <strong>{pending.preview.source}</strong>:
              </p>
              <PreviewCard preview={pending.preview} />
              <div className="button-row">
                <Button
                  size="sm"
                  disabled={busy || pending.preview.counts.total === 0}
                  onClick={() => void commit("merge")}
                >
                  Import {pending.preview.counts.total} nodes as a new group
                </Button>
                {pending.arborNative ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy || pending.preview.counts.total === 0}
                    onClick={() => setConfirmReplace(true)}
                  >
                    Replace whole tree
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPending(null)}>
                  Discard
                </Button>
              </div>
            </>
          ) : null}
          {status ? <div className="notice">{status}</div> : null}
        </div>
      </section>

      <section className="section">
        <div className="section__header">
          <h2 className="section__title">Recovering a Tabs Outliner tree</h2>
        </div>
        <div className="section__body">
          <p>Tabs Outliner keeps its last session in the extension page storage. To get it out:</p>
          <ol>
            <li>
              Open <code>chrome://extensions</code>, enable Developer mode and note Tabs
              Outliner&apos;s ID.
            </li>
            <li>
              Open <code>chrome-extension://&lt;ID&gt;/activesessionview.html</code> in a tab (or
              any page of the extension) and press F12 to open DevTools.
            </li>
            <li>
              In the Console run{" "}
              <code>copy(localStorage.getItem(&quot;{TABS_OUTLINER_STORAGE_KEY}&quot;))</code>.
            </li>
            <li>
              Paste into the box above and press Analyse. Exported .tree files work the same way.
            </li>
          </ol>
          <p>
            The importer is deliberately permissive: it looks for anything shaped like a window, tab
            or note and shows you the result before importing.
          </p>
        </div>
      </section>

      {pro === false ? (
        <UpsellRow feature="Scheduled backups run this export for you on a timer." />
      ) : null}

      {confirmReplace && pending ? (
        <ConfirmDialog
          title="Replace the whole tree?"
          confirmLabel="Replace"
          danger
          onConfirm={() => void commit("replace")}
          onCancel={() => setConfirmReplace(false)}
        >
          Your current {nodeCount} nodes will be replaced by the {pending.preview.counts.total}{" "}
          imported nodes. The current tree is written to a snapshot first and can be brought back
          from Recovery. Open windows are re-linked to the imported nodes where the URLs match.
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

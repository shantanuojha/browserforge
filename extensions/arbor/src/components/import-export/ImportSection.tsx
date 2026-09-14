import { useRef, type ChangeEvent } from "react";
import { Button } from "@browserforge/ui";
import type { ImportFlow } from "@/hooks/useImportFlow";
import { TABS_OUTLINER_STORAGE_KEY } from "@/lib/io/tabs-outliner";
import { ImportPreviewCard } from "./ImportPreviewCard";

interface PendingActionsProps {
  flow: ImportFlow;
  onReplace(): void;
}

/** What was recognised, and the buttons that import or drop it. */
function PendingActions({ flow, onReplace }: PendingActionsProps) {
  const { pending, busy } = flow;
  if (!pending) return null;
  const empty = pending.preview.counts.total === 0;
  return (
    <>
      <p>
        Recognised from <strong>{pending.preview.source}</strong>:
      </p>
      <ImportPreviewCard preview={pending.preview} />
      <div className="button-row">
        <Button size="sm" disabled={busy || empty} onClick={() => void flow.commit("merge")}>
          Import {pending.preview.counts.total} nodes as a new group
        </Button>
        {pending.arborNative ? (
          <Button size="sm" variant="secondary" disabled={busy || empty} onClick={onReplace}>
            Replace whole tree
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" disabled={busy} onClick={flow.discard}>
          Discard
        </Button>
      </div>
    </>
  );
}

export interface ImportSectionProps {
  flow: ImportFlow;
  pasted: string;
  onPasted(text: string): void;
  onReplace(): void;
}

export function ImportSection({ flow, pasted, onPasted, onReplace }: ImportSectionProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await flow.loadFile(file);
    } finally {
      e.target.value = ""; // so choosing the same file again fires onChange
    }
  };
  return (
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
            disabled={flow.busy}
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
          onChange={(e) => onPasted(e.target.value)}
          spellCheck={false}
        />
        <div className="button-row">
          <Button
            size="sm"
            variant="secondary"
            disabled={flow.busy || !pasted.trim()}
            onClick={() => flow.analyse(pasted)}
          >
            Analyse pasted text
          </Button>
        </div>
        {flow.error ? <div className="notice notice--error">{flow.error}</div> : null}
        <PendingActions flow={flow} onReplace={onReplace} />
        {flow.status ? <div className="notice">{flow.status}</div> : null}
      </div>
    </section>
  );
}

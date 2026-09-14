import { useState } from "react";
import { errorMessage, systemClock } from "@browserforge/shared";
import { downloadJson, readFileText } from "@/adapters/files";
import { msg } from "@/adapters/messaging";
import { newId } from "@/lib/ids";
import { exportFileName, isArborExport, parseArborExport } from "@/lib/io/arbor-json";
import { materialize, type ImportPreview } from "@/lib/io/imported";
import { parseTabsOutliner } from "@/lib/io/tabs-outliner";

export interface PendingImport {
  preview: ImportPreview;
  /** An Arbor export can also replace the whole tree; foreign data is only merged. */
  arborNative: boolean;
}

export type ImportMode = "merge" | "replace";

export interface ImportFlow {
  pending: PendingImport | null;
  error: string | null;
  status: string | null;
  busy: boolean;
  /** Recognise pasted or loaded text and show what it holds; nothing is written yet. */
  analyse(text: string): void;
  loadFile(file: File): Promise<void>;
  exportTree(): Promise<void>;
  commit(mode: ImportMode): Promise<void>;
  discard(): void;
}

/** Text that is not JSON is handed to the Tabs Outliner parser as is (it may be double-encoded). */
function parseLoosely(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function recognise(text: string): PendingImport {
  const parsed = parseLoosely(text);
  if (isArborExport(parsed)) {
    return { preview: parseArborExport(parsed, systemClock()), arborNative: true };
  }
  return { preview: parseTabsOutliner(parsed), arborNative: false };
}

/** The Import / Export screen's state machine: analyse, preview, commit or discard; export. */
export function useImportFlow(onCommitted: () => void): ImportFlow {
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const analyse = (text: string) => {
    setError(null);
    setStatus(null);
    try {
      setPending(recognise(text));
    } catch (e) {
      setPending(null);
      setError(errorMessage(e));
    }
  };

  const loadFile = async (file: File) => {
    try {
      analyse(await readFileText(file));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  /** Run a background operation with the busy flag held; failures show as the error notice. */
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true);
    try {
      await operation();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const exportTree = () =>
    perform(async () => {
      const data = await msg.exportTree.send();
      downloadJson(exportFileName(new Date()), data);
      setStatus(`Exported ${data.nodeCount} nodes.`);
    });

  const commit = async (mode: ImportMode) => {
    if (!pending) return;
    await perform(async () => {
      const wrapTitle =
        mode === "replace"
          ? null
          : `Imported from ${pending.preview.source} (${new Date().toLocaleDateString()})`;
      const nodes = materialize(pending.preview.roots, { wrapTitle, newId, now: systemClock });
      const count = await msg.importNodes.send({ nodes, mode });
      const where = mode === "merge" ? " into a new group at the bottom of the tree" : "";
      setStatus(`Imported ${count} nodes${where}.`);
      setPending(null);
      onCommitted();
    });
  };

  return {
    pending,
    error,
    status,
    busy,
    analyse,
    loadFile,
    exportTree,
    commit,
    discard: () => setPending(null),
  };
}

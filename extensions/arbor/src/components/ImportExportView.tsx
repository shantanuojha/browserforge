import { useCallback, useState } from "react";
import { Button } from "@browserforge/ui";
import { useImportFlow } from "@/hooks/useImportFlow";
import { ConfirmDialog } from "./ConfirmDialog";
import { ImportSection } from "./import-export/ImportSection";
import { TabsOutlinerInstructions } from "./import-export/TabsOutlinerInstructions";
import { UpsellRow } from "./UpsellRow";

export interface ImportExportViewProps {
  pro: boolean | null;
  nodeCount: number;
}

function ExportSection({
  nodeCount,
  busy,
  onExport,
}: {
  nodeCount: number;
  busy: boolean;
  onExport(): void;
}) {
  return (
    <section className="section">
      <div className="section__header">
        <h2 className="section__title">Export</h2>
      </div>
      <div className="section__body">
        <p>
          Save the whole tree ({nodeCount} nodes) as a JSON file you can re-import later or keep as
          a backup.
        </p>
        <div className="button-row">
          <Button size="sm" disabled={busy} onClick={onExport}>
            Export JSON
          </Button>
        </div>
      </div>
    </section>
  );
}

export function ImportExportView({ pro, nodeCount }: ImportExportViewProps) {
  const [pasted, setPasted] = useState("");
  const [confirmReplace, setConfirmReplace] = useState(false);
  const onCommitted = useCallback(() => setPasted(""), []);
  const flow = useImportFlow(onCommitted);
  const { pending } = flow;

  return (
    <div className="page">
      <ExportSection
        nodeCount={nodeCount}
        busy={flow.busy}
        onExport={() => void flow.exportTree()}
      />
      <ImportSection
        flow={flow}
        pasted={pasted}
        onPasted={setPasted}
        onReplace={() => setConfirmReplace(true)}
      />
      <TabsOutlinerInstructions />

      {pro === false ? (
        <UpsellRow feature="Scheduled backups run this export for you on a timer." />
      ) : null}

      {confirmReplace && pending ? (
        <ConfirmDialog
          title="Replace the whole tree?"
          confirmLabel="Replace"
          danger
          onConfirm={() => {
            setConfirmReplace(false);
            void flow.commit("replace");
          }}
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

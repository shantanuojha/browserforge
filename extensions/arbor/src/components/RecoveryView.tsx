import { useCallback, useState } from "react";
import { errorMessage } from "@browserforge/shared";
import { Button } from "@browserforge/ui";
import { msg } from "@/adapters/messaging";
import { useRecoveryData } from "@/hooks/useRecoveryData";
import { formatDateTime } from "@/lib/format";
import type { SnapshotMeta } from "@/lib/store/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { IntegrityReport } from "./recovery/IntegrityReport";
import { SnapshotList } from "./recovery/SnapshotList";

export interface RecoveryViewProps {
  currentNodeCount: number;
}

export function RecoveryView({ currentNodeCount }: RecoveryViewProps) {
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState<SnapshotMeta | null>(null);
  const [busy, setBusy] = useState(false);
  const onError = useCallback((message: string) => setStatus(message), []);
  const { snapshots, quarantine, startup, refresh } = useRecoveryData(onError);

  /** Run a background operation, show its outcome, then reload the lists. */
  const perform = async (operation: () => Promise<string>) => {
    setBusy(true);
    try {
      setStatus(await operation());
      await refresh();
    } catch (e) {
      setStatus(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (snap: SnapshotMeta) => {
    try {
      await perform(async () => {
        const count = await msg.restoreSnapshot.send({ seq: snap.seq });
        return `Restored snapshot #${snap.seq} (${count} nodes). Open windows were re-linked.`;
      });
    } finally {
      setPending(null);
    }
  };

  const snapshotNow = () =>
    perform(async () => {
      const meta = await msg.compactNow.send();
      return meta
        ? `Snapshot #${meta.seq} written (${meta.nodeCount} nodes).`
        : "Nothing to snapshot.";
    });

  return (
    <div className="page">
      <section className="section">
        <div className="section__header">
          <h2 className="section__title">Snapshots</h2>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void snapshotNow()}>
            Snapshot now
          </Button>
        </div>
        <div className="section__body">
          <p>
            Arbor writes an append-only log of every change and compacts it into a snapshot every
            200 changes or few minutes. Restoring a snapshot replaces the tree with that point in
            time; the current tree is kept as a new snapshot first, so you can always come back.
          </p>
          <p>Current tree: {currentNodeCount} nodes.</p>
          <SnapshotList snapshots={snapshots} busy={busy} onRestore={setPending} />
          {status ? <div className="notice">{status}</div> : null}
        </div>
      </section>

      <section className="section">
        <div className="section__header">
          <h2 className="section__title">Integrity check</h2>
        </div>
        <div className="section__body">
          <IntegrityReport startup={startup} quarantine={quarantine} />
        </div>
      </section>

      {pending ? (
        <ConfirmDialog
          title={`Restore snapshot #${pending.seq}?`}
          confirmLabel="Restore"
          onConfirm={() => void restore(pending)}
          onCancel={() => setPending(null)}
        >
          The tree will be replaced with the {pending.nodeCount} nodes saved on{" "}
          {formatDateTime(pending.ts)}. Your current tree ({currentNodeCount} nodes) is saved as a
          new snapshot first. Open tabs are re-linked to the restored nodes where possible.
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

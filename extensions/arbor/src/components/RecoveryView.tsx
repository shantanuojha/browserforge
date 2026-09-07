import { useCallback, useEffect, useState } from "react";
import { Button } from "@browserforge/ui";
import { formatDateTime } from "@/lib/download";
import { msg, type StartupInfo } from "@/lib/messages";
import type { QuarantinedOp, SnapshotMeta } from "@/lib/store/types";
import { ConfirmDialog } from "./ConfirmDialog";

export interface RecoveryViewProps {
  currentNodeCount: number;
}

export function RecoveryView({ currentNodeCount }: RecoveryViewProps) {
  const [snapshots, setSnapshots] = useState<SnapshotMeta[] | null>(null);
  const [quarantine, setQuarantine] = useState<QuarantinedOp[]>([]);
  const [startup, setStartup] = useState<StartupInfo | null>(null);
  const [pending, setPending] = useState<SnapshotMeta | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [snaps, q, info] = await Promise.all([
      msg.listSnapshots.send(),
      msg.listQuarantine.send(),
      msg.getStartupInfo.send(),
    ]);
    setSnapshots(snaps);
    setQuarantine(q);
    setStartup(info);
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([msg.listSnapshots.send(), msg.listQuarantine.send(), msg.getStartupInfo.send()])
      .then(([snaps, q, info]) => {
        if (cancelled) return;
        setSnapshots(snaps);
        setQuarantine(q);
        setStartup(info);
      })
      .catch((e: unknown) => {
        if (!cancelled) setStatus(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const restore = async (snap: SnapshotMeta) => {
    setBusy(true);
    try {
      const count = await msg.restoreSnapshot.send({ seq: snap.seq });
      setStatus(`Restored snapshot #${snap.seq} (${count} nodes). Open windows were re-linked.`);
      await refresh();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const snapshotNow = async () => {
    setBusy(true);
    try {
      const meta = await msg.compactNow.send();
      setStatus(
        meta ? `Snapshot #${meta.seq} written (${meta.nodeCount} nodes).` : "Nothing to snapshot.",
      );
      await refresh();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const report = startup?.report;

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
          {snapshots === null ? (
            <p>Loading...</p>
          ) : snapshots.length === 0 ? (
            <p>No snapshots yet. The first one is written after a few changes.</p>
          ) : (
            <div className="list" role="list">
              {snapshots.map((s, i) => (
                <div
                  key={s.seq}
                  className={i === 0 ? "list__item list__item--current" : "list__item"}
                  role="listitem"
                >
                  <div className="list__grow">
                    <div>
                      {formatDateTime(s.ts)} <span className="list__muted">#{s.seq}</span>
                      {i === 0 ? <span className="list__muted"> (latest)</span> : null}
                    </div>
                    <div className="list__muted">{s.nodeCount} nodes</div>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setPending(s)}
                  >
                    Restore
                  </Button>
                </div>
              ))}
            </div>
          )}
          {status ? <div className="notice">{status}</div> : null}
        </div>
      </section>

      <section className="section">
        <div className="section__header">
          <h2 className="section__title">Integrity check</h2>
        </div>
        <div className="section__body">
          {report ? (
            <>
              <p>
                Last start: loaded snapshot #{report.snapshotSeq}, replayed {report.replayed} change
                {report.replayed === 1 ? "" : "s"}
                {report.quarantined ? `, quarantined ${report.quarantined}` : ""}
                {report.skippedSnapshots
                  ? `, skipped ${report.skippedSnapshots} unreadable snapshot(s)`
                  : ""}
                .
              </p>
              {report.warnings.length ? (
                <div className="notice notice--warn">
                  Recovered with warnings:
                  <ul>
                    {report.warnings.slice(0, 6).map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {startup?.rebuild ? (
                <p>
                  Live windows: {startup.rebuild.windowsMatched} matched,{" "}
                  {startup.rebuild.windowsCreated} new; tabs: {startup.rebuild.tabsMatched} matched,{" "}
                  {startup.rebuild.tabsCreated} new; {startup.rebuild.nodesSaved} node(s) marked
                  saved.
                </p>
              ) : null}
            </>
          ) : (
            <p>Loading...</p>
          )}
          {quarantine.length ? (
            <div className="notice notice--warn">
              {quarantine.length} change(s) could not be replayed and were set aside so the rest of
              the tree could load. They are kept for inspection but are not part of the tree.
              <ul>
                {quarantine.slice(0, 5).map((q) => (
                  <li key={q.op.seq}>
                    #{q.op.seq} {q.op.type}: {q.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p>No quarantined changes.</p>
          )}
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

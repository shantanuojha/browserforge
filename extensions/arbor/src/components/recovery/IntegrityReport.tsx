import type { StartupInfo } from "@/lib/messages";
import type { OpenReport, QuarantinedOp } from "@/lib/store/types";
import type { RebuildReport } from "@/lib/sync/types";

function OpenSummary({ report }: { report: OpenReport }) {
  const quarantined = report.quarantined ? `, quarantined ${report.quarantined}` : "";
  const skipped = report.skippedSnapshots
    ? `, skipped ${report.skippedSnapshots} unreadable snapshot(s)`
    : "";
  return (
    <p>
      Last start: loaded snapshot #{report.snapshotSeq}, replayed {report.replayed} change
      {report.replayed === 1 ? "" : "s"}
      {quarantined}
      {skipped}.
    </p>
  );
}

function RebuildSummary({ rebuild }: { rebuild: RebuildReport }) {
  const pruned = rebuild.windowsPruned
    ? `; ${rebuild.windowsPruned} empty window node(s) removed`
    : "";
  return (
    <p>
      Live windows: {rebuild.windowsMatched} matched, {rebuild.windowsCreated} new; tabs:{" "}
      {rebuild.tabsMatched} matched, {rebuild.tabsCreated} new; {rebuild.nodesSaved} node(s) marked
      saved
      {pruned}.
    </p>
  );
}

function Warnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <div className="notice notice--warn">
      Recovered with warnings:
      <ul>
        {warnings.slice(0, 6).map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

function Quarantine({ quarantine }: { quarantine: QuarantinedOp[] }) {
  if (!quarantine.length) return <p>No quarantined changes.</p>;
  return (
    <div className="notice notice--warn">
      {quarantine.length} change(s) could not be replayed and were set aside so the rest of the tree
      could load. They are kept for inspection but are not part of the tree.
      <ul>
        {quarantine.slice(0, 5).map((q) => (
          <li key={q.op.seq}>
            #{q.op.seq} {q.op.type}: {q.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface IntegrityReportProps {
  startup: StartupInfo | null;
  quarantine: QuarantinedOp[];
}

/** What the last start found: the snapshot loaded, the log replayed, the browser re-linked. */
export function IntegrityReport({ startup, quarantine }: IntegrityReportProps) {
  const report = startup?.report;
  return (
    <>
      {report ? (
        <>
          <OpenSummary report={report} />
          <Warnings warnings={report.warnings} />
          {startup?.rebuild ? <RebuildSummary rebuild={startup.rebuild} /> : null}
        </>
      ) : (
        <p>Loading...</p>
      )}
      <Quarantine quarantine={quarantine} />
    </>
  );
}

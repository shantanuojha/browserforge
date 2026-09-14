import { Button } from "@browserforge/ui";
import { formatDateTime } from "@/lib/format";
import type { SnapshotMeta } from "@/lib/store/types";

export interface SnapshotListProps {
  snapshots: SnapshotMeta[] | null;
  busy: boolean;
  onRestore(snapshot: SnapshotMeta): void;
}

function SnapshotItem({
  snapshot,
  latest,
  busy,
  onRestore,
}: {
  snapshot: SnapshotMeta;
  latest: boolean;
  busy: boolean;
  onRestore(): void;
}) {
  return (
    <div className={latest ? "list__item list__item--current" : "list__item"} role="listitem">
      <div className="list__grow">
        <div>
          {formatDateTime(snapshot.ts)} <span className="list__muted">#{snapshot.seq}</span>
          {latest ? <span className="list__muted"> (latest)</span> : null}
        </div>
        <div className="list__muted">{snapshot.nodeCount} nodes</div>
      </div>
      <Button size="sm" variant="secondary" disabled={busy} onClick={onRestore}>
        Restore
      </Button>
    </div>
  );
}

export function SnapshotList({ snapshots, busy, onRestore }: SnapshotListProps) {
  if (snapshots === null) return <p>Loading...</p>;
  if (snapshots.length === 0) {
    return <p>No snapshots yet. The first one is written after a few changes.</p>;
  }
  return (
    <div className="list" role="list">
      {snapshots.map((s, i) => (
        <SnapshotItem
          key={s.seq}
          snapshot={s}
          latest={i === 0}
          busy={busy}
          onRestore={() => onRestore(s)}
        />
      ))}
    </div>
  );
}

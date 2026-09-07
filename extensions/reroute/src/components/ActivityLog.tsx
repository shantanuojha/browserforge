import { Button } from "@browserforge/ui";
import type { LogEntry, LogKind } from "../lib/log";

export interface ActivityLogProps {
  entries: LogEntry[];
  onClear: () => void;
}

const KIND_LABEL: Record<LogKind, string> = {
  js: "JS redirect",
  dnr: "DNR match",
  loop: "Loop stopped",
  skip: "Skipped",
  error: "Error",
};

export function ActivityLog({ entries, onClear }: ActivityLogProps) {
  const newestFirst = [...entries].reverse();
  return (
    <div className="rr-stack">
      <div className="rr-row rr-row--between">
        <p className="rr-help" style={{ margin: 0 }}>
          The last {entries.length} events from the JavaScript fallback. Redirects performed by
          declarativeNetRequest are only listed in unpacked (development) builds, where the browser
          exposes onRuleMatchedDebug.
        </p>
        <Button size="sm" variant="secondary" onClick={onClear} disabled={entries.length === 0}>
          Clear log
        </Button>
      </div>
      {newestFirst.length === 0 ? (
        <p className="rr-muted">Nothing recorded yet.</p>
      ) : (
        <table className="rr-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Event</th>
              <th>From</th>
              <th>To</th>
              <th>Rule / detail</th>
            </tr>
          </thead>
          <tbody>
            {newestFirst.map((e, i) => (
              <tr key={`${e.at}-${i}`}>
                <td style={{ whiteSpace: "nowrap" }}>{new Date(e.at).toLocaleTimeString()}</td>
                <td>{KIND_LABEL[e.kind]}</td>
                <td className="rr-mono">{e.from}</td>
                <td className="rr-mono">{e.to ?? ""}</td>
                <td>
                  {e.ruleName ? <div>{e.ruleName}</div> : null}
                  {e.detail ? <div className="rr-muted">{e.detail}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

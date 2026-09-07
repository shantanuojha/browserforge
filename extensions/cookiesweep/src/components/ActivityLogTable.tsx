import { Button } from "@browserforge/ui";
import type { ActivityEntry, CleanupTrigger } from "../lib/settings.js";
import { ConfirmButton } from "./ConfirmButton.js";

const TRIGGER_LABELS: Record<CleanupTrigger, string> = {
  "tab-close": "Tab closed",
  "domain-change": "Left site",
  startup: "Browser start",
  manual: "Manual",
};

const formatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export interface ActivityLogTableProps {
  entries: readonly ActivityEntry[];
  onClear: () => void | Promise<void>;
  onRefresh?: () => void;
}

export function ActivityLogTable({ entries, onClear, onRefresh }: ActivityLogTableProps) {
  return (
    <div className="cs-stack">
      <div className="cs-row">
        <span className="cs-small cs-muted">
          {entries.length === 0
            ? "Nothing cleaned yet."
            : `${entries.length} cleanup${entries.length === 1 ? "" : "s"} recorded (newest first, last 500 kept).`}
        </span>
        <span style={{ flex: 1 }} />
        {onRefresh ? (
          <Button size="sm" variant="ghost" onClick={onRefresh}>
            Refresh
          </Button>
        ) : null}
        <ConfirmButton
          size="sm"
          label="Clear log"
          confirmLabel="Clear"
          prompt="Clear the activity log?"
          disabled={entries.length === 0}
          onConfirm={onClear}
        />
      </div>
      {entries.length > 0 ? (
        <div className="cs-table-wrap cs-table--scroll">
          <table className="cs-table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Trigger</th>
                <th scope="col">Domains</th>
                <th scope="col">Cookies</th>
                <th scope="col">Site data</th>
                <th scope="col">Store</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="cs-nowrap">{formatter.format(new Date(entry.at))}</td>
                  <td className="cs-nowrap">{TRIGGER_LABELS[entry.trigger] ?? entry.trigger}</td>
                  <td className="cs-mono" title={entry.domains.join(", ")}>
                    {entry.domains.length <= 4
                      ? entry.domains.join(", ")
                      : `${entry.domains.slice(0, 4).join(", ")} +${entry.domains.length - 4}`}
                  </td>
                  <td>{entry.cookiesRemoved}</td>
                  <td>{entry.siteDataDomains}</td>
                  <td className="cs-muted">{entry.storeId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

import { Button, ProBadge } from "@browserforge/ui";
import type { BackupsApi } from "@/hooks/useBackups";
import { describeScheduledOutcome, type BackupMeta, type ScheduledRun } from "@/lib/backups";
import { formatDateTime } from "@/lib/format";
import type { Settings } from "@/lib/settings";
import { UpsellRow } from "../UpsellRow";
import { Field, NumberField } from "./Field";

type BackupSettings = Settings["backups"];

export interface BackupsSectionProps {
  settings: BackupSettings;
  /** Pro is not active: controls are disabled and the upsell shows. */
  gated: boolean;
  setBackup<K extends keyof BackupSettings>(key: K, value: BackupSettings[K]): void;
  backups: BackupsApi;
  /** What the schedule did on its last tick; `undefined` until it has run once. */
  lastRun: ScheduledRun | undefined;
  /** Outcome of the last operation, shown under the list. */
  status: string | null;
  /** Google Drive backup, while it is not shipped, is hidden; the flag lives in `lib/pro.ts`. */
  drive?: DriveBackupProps | undefined;
}

/** Tells the user whether the schedule is doing its job, and if not, why. */
function LastScheduledRun({ run, enabled }: { run: ScheduledRun | undefined; enabled: boolean }) {
  if (!run) return enabled ? <p className="list__muted">No scheduled backup has run yet.</p> : null;
  return (
    <p className="list__muted">
      Last scheduled run: {formatDateTime(run.at)} {"\u2014"}{" "}
      {describeScheduledOutcome(run.outcome)}
    </p>
  );
}

function BackupList({ backups }: { backups: BackupsApi }) {
  if (!backups.backups.length) return <p>No stored backups yet.</p>;
  return (
    <div className="list" role="list">
      {backups.backups.map((b: BackupMeta) => (
        <div key={b.ts} className="list__item" role="listitem">
          <div className="list__grow">
            {formatDateTime(b.ts)} <span className="list__muted">{b.nodeCount} nodes</span>
          </div>
          <Button size="sm" variant="secondary" onClick={() => void backups.download(b)}>
            Save file
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void backups.remove(b)}>
            Delete
          </Button>
        </div>
      ))}
    </div>
  );
}

export interface DriveBackupProps {
  enabled: boolean;
  identityGranted: boolean | null;
  gated: boolean;
  onToggle(enabled: boolean): void;
}

function DriveBackupField({ enabled, identityGranted, gated, onToggle }: DriveBackupProps) {
  return (
    <>
      <Field
        label="Google Drive backup"
        hint={
          identityGranted
            ? "Sign-in permission granted."
            : "Asks for the optional identity permission when enabled."
        }
        htmlFor="drive-enabled"
      >
        <input
          id="drive-enabled"
          type="checkbox"
          disabled={gated}
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
        />
      </Field>
      {gated ? <UpsellRow feature="Google Drive backup." /> : null}
    </>
  );
}

export function BackupsSection(props: BackupsSectionProps) {
  const { settings, gated, setBackup, backups, lastRun, status, drive } = props;
  return (
    <section className="section">
      <div className="section__header">
        <h2 className="section__title">
          Backups <ProBadge title="Pro feature" />
        </h2>
        <Button
          size="sm"
          variant="secondary"
          disabled={gated}
          onClick={() => void backups.backupNow()}
        >
          Back up now
        </Button>
      </div>
      <div className="section__body">
        <p>
          Scheduled backups export the whole tree on a timer and keep the newest copies here, ready
          to save as files. Manual export in the side panel is always free.
        </p>
        {gated ? <UpsellRow feature="Scheduled local backups with rolling retention." /> : null}
        <Field label="Scheduled backups" htmlFor="backups-enabled">
          <input
            id="backups-enabled"
            type="checkbox"
            disabled={gated}
            checked={settings.enabled}
            onChange={(e) => setBackup("enabled", e.target.checked)}
          />
        </Field>
        <Field label="Every N minutes" htmlFor="backups-interval">
          <NumberField
            id="backups-interval"
            min={5}
            max={1440}
            disabled={gated}
            value={settings.intervalMinutes}
            onCommit={(v) => setBackup("intervalMinutes", v)}
          />
        </Field>
        <Field label="Keep the newest N backups" htmlFor="backups-retention">
          <NumberField
            id="backups-retention"
            min={1}
            max={100}
            disabled={gated}
            value={settings.retention}
            onCommit={(v) => setBackup("retention", v)}
          />
        </Field>
        <LastScheduledRun run={lastRun} enabled={settings.enabled && !gated} />
        <BackupList backups={backups} />
        {drive ? <DriveBackupField {...drive} /> : null}
        {status ? <div className="notice">{status}</div> : null}
      </div>
    </section>
  );
}

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { browser } from "wxt/browser";
import { Button, ProBadge } from "@browserforge/ui";
import { openProPage, UpsellRow } from "@/components/UpsellRow";
import { usePro } from "@/hooks/usePro";
import { useSettings } from "@/hooks/useSettings";
import type { BackupMeta } from "@/lib/backups";
import { downloadJson, formatDateTime } from "@/lib/download";
import { msg } from "@/lib/messages";
import type { Settings } from "@/lib/settings";

function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        <span>{label}</span>
        {hint ? <span className="field__hint">{hint}</span> : null}
      </label>
      {children}
    </div>
  );
}

export function App() {
  const [settings, update, loaded] = useSettings();
  const pro = usePro();
  const [backups, setBackups] = useState<BackupMeta[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [identityGranted, setIdentityGranted] = useState<boolean | null>(null);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    void update({ ...settings, [key]: value });
  const setBackup = <K extends keyof Settings["backups"]>(key: K, value: Settings["backups"][K]) =>
    void update({ ...settings, backups: { ...settings.backups, [key]: value } });

  const refreshBackups = useCallback(async () => {
    try {
      setBackups(await msg.listBackups.send());
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    msg.listBackups
      .send()
      .then((list) => {
        if (!cancelled) setBackups(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) setStatus(e instanceof Error ? e.message : String(e));
      });
    browser.permissions
      .contains({ permissions: ["identity"] })
      .then((granted) => {
        if (!cancelled) setIdentityGranted(granted);
      })
      .catch(() => {
        if (!cancelled) setIdentityGranted(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const backupNow = async () => {
    try {
      const meta = await msg.runBackupNow.send();
      setStatus(`Backup written: ${formatDateTime(meta.ts)} (${meta.nodeCount} nodes).`);
      await refreshBackups();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const download = async (b: BackupMeta) => {
    const data = await msg.getBackup.send({ ts: b.ts });
    if (!data) {
      setStatus("That backup no longer exists.");
      return;
    }
    const d = new Date(b.ts);
    const pad = (n: number) => String(n).padStart(2, "0");
    downloadJson(
      `arbor-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`,
      data,
    );
  };

  const toggleDrive = async (enabled: boolean) => {
    if (enabled) {
      try {
        const granted = await browser.permissions.request({ permissions: ["identity"] });
        setIdentityGranted(granted);
        if (!granted) return;
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    setBackup("driveEnabled", enabled);
  };

  if (!loaded) return <div className="page page--options">Loading...</div>;

  const gated = pro !== true;

  return (
    <div className="page page--options">
      <h1 className="app__title" style={{ fontSize: 18 }}>
        Arbor options {pro ? <ProBadge /> : null}
      </h1>

      <section className="section">
        <div className="section__header">
          <h2 className="section__title">General</h2>
        </div>
        <div className="section__body">
          <Field
            label="Snapshot interval"
            hint="Minutes between compacted snapshots of the change log (a snapshot is also taken every 200 changes)."
            htmlFor="compaction"
          >
            <input
              id="compaction"
              type="number"
              min={1}
              max={120}
              value={settings.compactionIntervalMinutes}
              onChange={(e) => set("compactionIntervalMinutes", Number(e.target.value))}
            />
          </Field>
          <Field label="Confirm before Close all and save" htmlFor="confirm-close">
            <input
              id="confirm-close"
              type="checkbox"
              checked={settings.confirmCloseAll}
              onChange={(e) => set("confirmCloseAll", e.target.checked)}
            />
          </Field>
          <Field
            label="Theme follows OS"
            hint="Turn off to pick light or dark explicitly."
            htmlFor="theme-os"
          >
            <input
              id="theme-os"
              type="checkbox"
              checked={settings.theme === "system"}
              onChange={(e) => set("theme", e.target.checked ? "system" : "light")}
            />
          </Field>
          {settings.theme !== "system" ? (
            <Field label="Theme" htmlFor="theme">
              <select
                id="theme"
                value={settings.theme}
                onChange={(e) => set("theme", e.target.value === "dark" ? "dark" : "light")}
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </Field>
          ) : null}
          <Field label="Keyboard shortcut" hint="Change it under chrome://extensions/shortcuts.">
            <code>Alt+Shift+A</code>
          </Field>
        </div>
      </section>

      <section className="section">
        <div className="section__header">
          <h2 className="section__title">
            Backups <ProBadge title="Pro feature" />
          </h2>
          <Button size="sm" variant="secondary" disabled={gated} onClick={() => void backupNow()}>
            Back up now
          </Button>
        </div>
        <div className="section__body">
          <p>
            Scheduled backups export the whole tree on a timer and keep the newest copies here,
            ready to save as files. Manual export in the side panel is always free.
          </p>
          {gated ? <UpsellRow feature="Scheduled local backups with rolling retention." /> : null}
          <Field label="Scheduled backups" htmlFor="backups-enabled">
            <input
              id="backups-enabled"
              type="checkbox"
              disabled={gated}
              checked={settings.backups.enabled}
              onChange={(e) => setBackup("enabled", e.target.checked)}
            />
          </Field>
          <Field label="Every N minutes" htmlFor="backups-interval">
            <input
              id="backups-interval"
              type="number"
              min={5}
              max={1440}
              disabled={gated}
              value={settings.backups.intervalMinutes}
              onChange={(e) => setBackup("intervalMinutes", Number(e.target.value))}
            />
          </Field>
          <Field label="Keep the newest N backups" htmlFor="backups-retention">
            <input
              id="backups-retention"
              type="number"
              min={1}
              max={100}
              disabled={gated}
              value={settings.backups.retention}
              onChange={(e) => setBackup("retention", Number(e.target.value))}
            />
          </Field>
          {backups.length ? (
            <div className="list" role="list">
              {backups.map((b) => (
                <div key={b.ts} className="list__item" role="listitem">
                  <div className="list__grow">
                    {formatDateTime(b.ts)} <span className="list__muted">{b.nodeCount} nodes</span>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => void download(b)}>
                    Save file
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void msg.deleteBackup.send({ ts: b.ts }).then(refreshBackups)}
                  >
                    Delete
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p>No stored backups yet.</p>
          )}

          <Field
            label="Google Drive backup"
            hint={
              identityGranted
                ? "Sign-in permission granted. Uploading is not implemented in this build yet."
                : "Asks for the optional identity permission when enabled. Uploading is not implemented in this build yet."
            }
            htmlFor="drive-enabled"
          >
            <input
              id="drive-enabled"
              type="checkbox"
              disabled={gated}
              checked={settings.backups.driveEnabled}
              onChange={(e) => void toggleDrive(e.target.checked)}
            />
          </Field>
          {gated ? <UpsellRow feature="Google Drive backup." /> : null}
          {status ? <div className="notice">{status}</div> : null}
        </div>
      </section>

      <section className="section">
        <div className="section__header">
          <h2 className="section__title">
            Power keys <ProBadge title="Pro feature" />
          </h2>
        </div>
        <div className="section__body">
          <p>Multi-select, cut and paste subtrees, copy a subtree as a Markdown or HTML list.</p>
          {gated ? (
            <UpsellRow feature="Power keyboard and clipboard commands." />
          ) : (
            <p>Coming in a later build. Your licence already covers it.</p>
          )}
        </div>
      </section>

      <section className="section">
        <div className="section__header">
          <h2 className="section__title">Pro</h2>
        </div>
        <div className="section__body">
          <p>
            {pro
              ? "Pro is active on this browser."
              : "Arbor Pro is a $15 one-time purchase. The licence key dialog will appear here once licensing ships."}
          </p>
          <div className="button-row">
            <span title="Coming soon" style={{ display: "inline-flex" }}>
              <Button size="sm" variant="secondary" disabled aria-describedby="licence-hint">
                Enter licence key
              </Button>
            </span>
            <span id="licence-hint" className="list__muted">
              Coming soon
            </span>
            {!pro ? (
              <Button size="sm" onClick={openProPage}>
                Get Pro
              </Button>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

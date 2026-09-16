import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "@browserforge/shared";
import { ProBadge } from "@browserforge/ui";
import { hasIdentityPermission, requestIdentityPermission } from "@/adapters/permissions";
import { LicenseSection } from "@/components/LicenseSection";
import { BackupsSection, type DriveBackupProps } from "@/components/options/BackupsSection";
import { GeneralSection } from "@/components/options/GeneralSection";
import { useBackups } from "@/hooks/useBackups";
import { usePro } from "@/hooks/usePro";
import { useScheduledRun } from "@/hooks/useScheduledRun";
import { useSettings } from "@/hooks/useSettings";
import { DRIVE_BACKUP_ENABLED } from "@/lib/pro";
import type { Settings } from "@/lib/settings";

/** Whether the optional `identity` permission is granted; only asked while Drive backup is shipped. */
function useIdentityPermission(): [boolean | null, (granted: boolean) => void] {
  const [granted, setGranted] = useState<boolean | null>(null);
  useEffect(() => {
    if (!DRIVE_BACKUP_ENABLED) return;
    let cancelled = false;
    hasIdentityPermission()
      .then((value) => {
        if (!cancelled) setGranted(value);
      })
      .catch(() => {
        if (!cancelled) setGranted(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return [granted, setGranted];
}

function PlannedSection() {
  return (
    <section className="section">
      <div className="section__header">
        <h2 className="section__title">Planned</h2>
      </div>
      <div className="section__body">
        <p>
          Not in this version and not part of Pro yet: Google Drive backup, and power keys
          (multi-select, cut and paste subtrees, copy a subtree as a Markdown or HTML list).
        </p>
      </div>
    </section>
  );
}

export function App() {
  const [settings, update, loaded] = useSettings();
  const pro = usePro();
  const [status, setStatus] = useState<string | null>(null);
  const report = useCallback((text: string) => setStatus(text), []);
  const backups = useBackups(report);
  const lastRun = useScheduledRun();
  const [identityGranted, setIdentityGranted] = useIdentityPermission();

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    void update({ ...settings, [key]: value });
  const setBackup = <K extends keyof Settings["backups"]>(key: K, value: Settings["backups"][K]) =>
    void update({ ...settings, backups: { ...settings.backups, [key]: value } });

  const toggleDrive = async (enabled: boolean) => {
    if (enabled) {
      try {
        const granted = await requestIdentityPermission();
        setIdentityGranted(granted);
        if (!granted) return;
      } catch (e) {
        setStatus(errorMessage(e));
        return;
      }
    }
    setBackup("driveEnabled", enabled);
  };

  if (!loaded) return <div className="page page--options">Loading...</div>;

  const gated = pro !== true;
  const drive: DriveBackupProps | undefined = DRIVE_BACKUP_ENABLED
    ? {
        enabled: settings.backups.driveEnabled,
        identityGranted,
        gated,
        onToggle: (enabled) => void toggleDrive(enabled),
      }
    : undefined;

  return (
    <div className="page page--options">
      <h1 className="app__title" style={{ fontSize: 18 }}>
        Arbor options {pro ? <ProBadge /> : null}
      </h1>
      <GeneralSection settings={settings} set={set} />
      <BackupsSection
        settings={settings.backups}
        gated={gated}
        setBackup={setBackup}
        backups={backups}
        lastRun={lastRun}
        status={status}
        drive={drive}
      />
      <LicenseSection />
      <PlannedSection />
    </div>
  );
}

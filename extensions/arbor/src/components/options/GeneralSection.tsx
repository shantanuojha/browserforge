import type { Settings } from "@/lib/settings";
import { Field, NumberField } from "./Field";

export interface GeneralSectionProps {
  settings: Settings;
  set<K extends keyof Settings>(key: K, value: Settings[K]): void;
}

export function GeneralSection({ settings, set }: GeneralSectionProps) {
  return (
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
          <NumberField
            id="compaction"
            min={1}
            max={120}
            value={settings.compactionIntervalMinutes}
            onCommit={(v) => set("compactionIntervalMinutes", v)}
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
  );
}

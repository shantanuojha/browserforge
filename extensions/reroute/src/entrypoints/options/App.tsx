import { Button, Panel, ProBadge } from "@browserforge/ui";
import { useCallback, useEffect, useState } from "react";
import { allowlistItem, logItem, rulesItem, settingsItem } from "../../adapters/storage";
import { ActivityLog } from "../../components/ActivityLog";
import { AllowlistEditor } from "../../components/AllowlistEditor";
import { ImportExport, type ImportMode } from "../../components/ImportExport";
import { ProPanel } from "../../components/ProPanel";
import { RuleEditor } from "../../components/RuleEditor";
import { RuleList } from "../../components/RuleList";
import { TrackingPanel } from "../../components/TrackingPanel";
import { useBackgroundStatus } from "../../hooks/useBackgroundStatus";
import { usePro } from "../../hooks/usePro";
import { useStorageItem } from "../../hooks/useStorageItem";
import type { StatusResponse } from "../../lib/messages";
import { appendRules, createRule, type Rule } from "../../lib/rules/model";

type Tab = "rules" | "import" | "tracking" | "allowlist" | "activity" | "pro";

const TABS: { id: Tab; label: string }[] = [
  { id: "rules", label: "Rules" },
  { id: "import", label: "Import / Export" },
  { id: "tracking", label: "Tracking cleaner" },
  { id: "allowlist", label: "Allowlist" },
  { id: "activity", label: "Activity" },
  { id: "pro", label: "Pro" },
];

const isTab = (value: string): value is Tab => TABS.some((t) => t.id === value);

/** The selected tab, mirrored into the URL hash so a reload lands on the same section. */
function useHashTab(): [Tab, (tab: Tab) => void] {
  const [tab, setTab] = useState<Tab>(() => {
    const hash = window.location.hash.replace("#", "");
    return isTab(hash) ? hash : "rules";
  });
  useEffect(() => {
    window.location.hash = tab;
  }, [tab]);
  return [tab, setTab];
}

function engineSummary(status: StatusResponse | null): string {
  if (!status) return "";
  const network = `${status.dnrRules} rule${status.dnrRules === 1 ? "" : "s"}`;
  return ` ${network} run in the network layer, ${status.jsOnlyRuleIds.length} through the JavaScript fallback.`;
}

interface RulesTabProps {
  rules: Rule[];
  rulesLoaded: boolean;
  status: StatusResponse | null;
  onChange: (rules: Rule[]) => void;
}

function RulesTab({ rules, rulesLoaded, status, onChange }: RulesTabProps) {
  const [editing, setEditing] = useState<Rule | null>(null);
  const isExisting = editing !== null && rules.some((r) => r.id === editing.id);

  const saveRule = (rule: Rule) => {
    onChange(isExisting ? rules.map((r) => (r.id === rule.id ? rule : r)) : [...rules, rule]);
    setEditing(null);
  };

  let title = "Rules";
  if (editing) title = isExisting ? "Edit rule" : "New rule";

  return (
    <Panel
      title={title}
      actions={
        editing ? null : (
          <Button size="sm" onClick={() => setEditing(createRule())}>
            New rule
          </Button>
        )
      }
    >
      {editing ? (
        <RuleEditor
          rule={editing}
          allRules={rules}
          onSave={saveRule}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <div className="rr-stack">
          <p className="rr-help">
            Rules are tried top to bottom; the first match wins. Drag rows or use Up / Down to
            reorder.
            {engineSummary(status)}
          </p>
          {rulesLoaded ? (
            <RuleList
              rules={rules}
              jsOnlyReasons={status?.jsOnlyReasons ?? {}}
              onChange={onChange}
              onEdit={setEditing}
            />
          ) : (
            <p className="rr-muted">Loading...</p>
          )}
        </div>
      )}
    </Panel>
  );
}

interface NavProps {
  tab: Tab;
  onSelect: (tab: Tab) => void;
  enabledCount: number;
  pro: boolean | null;
  lastError: string | null | undefined;
}

function OptionsNav({ tab, onSelect, enabledCount, pro, lastError }: NavProps) {
  return (
    <nav className="rr-nav" aria-label="Settings sections">
      <div className="rr-nav__brand">Reroute</div>
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          className="rr-nav__item"
          aria-current={tab === t.id ? "page" : undefined}
          onClick={() => onSelect(t.id)}
        >
          <span>{t.label}</span>
          {t.id === "rules" ? <span className="rr-tag">{enabledCount}</span> : null}
          {t.id === "pro" && pro ? <ProBadge /> : null}
        </button>
      ))}
      {lastError ? (
        <div className="rr-notice rr-notice--error rr-small" style={{ marginTop: 12 }}>
          {lastError}
        </div>
      ) : null}
    </nav>
  );
}

export function App() {
  const [tab, setTab] = useHashTab();
  const [rules, setRules, rulesLoaded] = useStorageItem(rulesItem);
  const [allowlist, setAllowlist] = useStorageItem(allowlistItem);
  const [settings, setSettings] = useStorageItem(settingsItem);
  const [log, setLog] = useStorageItem(logItem);
  const pro = usePro();
  const { status, refresh: refreshStatus } = useBackgroundStatus();
  // Every one of these writes makes the background rebuild; ask for the new status afterwards.
  useEffect(() => refreshStatus(), [rules, allowlist, settings, refreshStatus]);

  const importRules = useCallback(
    (incoming: Rule[], mode: ImportMode) => {
      void setRules(mode === "replace" ? incoming : appendRules(rules, incoming));
    },
    [rules, setRules],
  );

  return (
    <div className="rr-options">
      <OptionsNav
        tab={tab}
        onSelect={setTab}
        enabledCount={rules.filter((r) => r.enabled).length}
        pro={pro}
        lastError={status?.lastError}
      />

      <main className="rr-main">
        {tab === "rules" ? (
          <RulesTab
            rules={rules}
            rulesLoaded={rulesLoaded}
            status={status}
            onChange={(next) => void setRules(next)}
          />
        ) : null}

        {tab === "import" ? (
          <Panel title="Import / Export">
            <ImportExport rules={rules} pro={pro} onImport={importRules} />
          </Panel>
        ) : null}

        {tab === "tracking" ? (
          <Panel title="Tracking-parameter cleaner">
            <TrackingPanel
              enabled={settings.trackingEnabled}
              onToggle={(trackingEnabled) => void setSettings({ ...settings, trackingEnabled })}
            />
          </Panel>
        ) : null}

        {tab === "allowlist" ? (
          <Panel title="Per-site allowlist">
            <AllowlistEditor allowlist={allowlist} onChange={(next) => void setAllowlist(next)} />
          </Panel>
        ) : null}

        {tab === "activity" ? (
          <Panel title="Activity">
            <ActivityLog entries={log} onClear={() => void setLog([])} />
          </Panel>
        ) : null}

        {tab === "pro" ? (
          <Panel title="Pro" actions={pro ? <ProBadge /> : null}>
            <ProPanel
              pro={pro}
              syncEnabled={settings.syncEnabled}
              onSyncToggle={(syncEnabled) => void setSettings({ ...settings, syncEnabled })}
              onInstallPack={(packRules) => {
                importRules(packRules, "append");
                setTab("rules");
              }}
            />
          </Panel>
        ) : null}
      </main>
    </div>
  );
}

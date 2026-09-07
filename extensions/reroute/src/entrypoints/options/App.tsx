import { Button, Panel, ProBadge } from "@browserforge/ui";
import { useCallback, useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { ActivityLog } from "../../components/ActivityLog";
import { AllowlistEditor } from "../../components/AllowlistEditor";
import { ImportExport } from "../../components/ImportExport";
import { ProPanel } from "../../components/ProPanel";
import { RuleEditor } from "../../components/RuleEditor";
import { RuleList } from "../../components/RuleList";
import { TrackingPanel } from "../../components/TrackingPanel";
import { usePro } from "../../hooks/usePro";
import { useStorageItem } from "../../hooks/useStorageItem";
import type { Message, StatusResponse } from "../../lib/messages";
import { createRule, type Rule } from "../../lib/rules/model";
import { allowlistItem, logItem, rulesItem, settingsItem } from "../../lib/storage";

type Tab = "rules" | "import" | "tracking" | "allowlist" | "activity" | "pro";

const TABS: { id: Tab; label: string }[] = [
  { id: "rules", label: "Rules" },
  { id: "import", label: "Import / Export" },
  { id: "tracking", label: "Tracking cleaner" },
  { id: "allowlist", label: "Allowlist" },
  { id: "activity", label: "Activity" },
  { id: "pro", label: "Pro" },
];

function useStatus(deps: unknown[]): StatusResponse | null {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    const msg: Message = { type: "reroute:get-status" };
    // Give the background a moment to recompile after a storage change.
    const t = setTimeout(() => {
      browser.runtime
        .sendMessage(msg)
        .then((res: unknown) => {
          if (!cancelled && res && typeof res === "object") setStatus(res as StatusResponse);
        })
        .catch(() => {
          if (!cancelled) setStatus(null);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return status;
}

export function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const hash = window.location.hash.replace("#", "");
    return TABS.some((t) => t.id === hash) ? (hash as Tab) : "rules";
  });
  const [rules, setRules, rulesLoaded] = useStorageItem(rulesItem);
  const [allowlist, setAllowlist] = useStorageItem(allowlistItem);
  const [settings, setSettings] = useStorageItem(settingsItem);
  const [log, setLog] = useStorageItem(logItem);
  const pro = usePro();
  const status = useStatus([rules, allowlist, settings]);
  const [editing, setEditing] = useState<Rule | null>(null);

  useEffect(() => {
    window.location.hash = tab;
  }, [tab]);

  const saveRule = useCallback(
    (rule: Rule) => {
      const exists = rules.some((r) => r.id === rule.id);
      void setRules(exists ? rules.map((r) => (r.id === rule.id ? rule : r)) : [...rules, rule]);
      setEditing(null);
    },
    [rules, setRules],
  );

  const importRules = useCallback(
    (incoming: Rule[], mode: "append" | "replace") => {
      void setRules(mode === "replace" ? incoming : [...rules, ...incoming]);
    },
    [rules, setRules],
  );

  const enabledCount = rules.filter((r) => r.enabled).length;

  return (
    <div className="rr-options">
      <nav className="rr-nav" aria-label="Settings sections">
        <div className="rr-nav__brand">Reroute</div>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className="rr-nav__item"
            aria-current={tab === t.id ? "page" : undefined}
            onClick={() => setTab(t.id)}
          >
            <span>{t.label}</span>
            {t.id === "rules" ? <span className="rr-tag">{enabledCount}</span> : null}
            {t.id === "pro" && pro ? <ProBadge /> : null}
          </button>
        ))}
        {status?.lastError ? (
          <div className="rr-notice rr-notice--error rr-small" style={{ marginTop: 12 }}>
            {status.lastError}
          </div>
        ) : null}
      </nav>

      <main className="rr-main">
        {tab === "rules" ? (
          <Panel
            title={
              editing
                ? rules.some((r) => r.id === editing.id)
                  ? "Edit rule"
                  : "New rule"
                : "Rules"
            }
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
                  {status
                    ? ` ${status.dnrRules} rule${status.dnrRules === 1 ? "" : "s"} run in the network layer, ${
                        status.jsOnlyRuleIds.length
                      } through the JavaScript fallback.`
                    : ""}
                </p>
                {rulesLoaded ? (
                  <RuleList
                    rules={rules}
                    jsOnlyReasons={status?.jsOnlyReasons ?? {}}
                    onChange={(next) => void setRules(next)}
                    onEdit={setEditing}
                  />
                ) : (
                  <p className="rr-muted">Loading...</p>
                )}
              </div>
            )}
          </Panel>
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

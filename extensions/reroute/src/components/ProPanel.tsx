import { Button } from "@browserforge/ui";
import { useState } from "react";
import { RULE_PACKS, instantiatePack, missingVariables, type RulePack } from "../lib/packs";
import { PRO_FEATURES } from "../lib/pro";
import type { Rule } from "../lib/rules/model";
import { LicensePanel } from "./LicensePanel";
import { Toggle } from "./Toggle";

export interface ProPanelProps {
  pro: boolean | null;
  syncEnabled: boolean;
  onSyncToggle: (enabled: boolean) => void;
  onInstallPack: (rules: Rule[]) => void;
}

function PackCard({
  pack,
  pro,
  onInstall,
}: {
  pack: RulePack;
  pro: boolean;
  onInstall: (r: Rule[]) => void;
}) {
  const [vars, setVars] = useState<Record<string, string>>(() =>
    Object.fromEntries(pack.variables.map((v) => [v.key, v.default])),
  );
  const [done, setDone] = useState(false);
  const missing = missingVariables(pack, vars);

  return (
    <div className="rr-pack">
      <h3 className="rr-pack__title">{pack.name}</h3>
      <p className="rr-help">{pack.description}</p>
      {pack.variables.length > 0 ? (
        <div className="rr-grid-2" style={{ marginBottom: 8 }}>
          {pack.variables.map((v) => (
            <div key={v.key} className="rr-field">
              <label htmlFor={`pack-${pack.id}-${v.key}`}>{v.label}</label>
              <input
                id={`pack-${pack.id}-${v.key}`}
                className="rr-input rr-input--mono"
                value={vars[v.key] ?? ""}
                placeholder={v.placeholder ?? ""}
                onChange={(e) => setVars((s) => ({ ...s, [v.key]: e.target.value }))}
                disabled={!pro}
                spellCheck={false}
              />
            </div>
          ))}
        </div>
      ) : null}
      <ul className="rr-list rr-small rr-muted">
        {instantiatePack(pack, vars).rules.map((r, i) => (
          <li key={i} className="rr-mono">
            {r.include} {"->"} {r.redirectTo}
            {r.enabled ? "" : " (disabled)"}
          </li>
        ))}
      </ul>
      <div className="rr-row" style={{ marginTop: 8 }}>
        <Button
          size="sm"
          disabled={!pro || missing.length > 0}
          title={
            !pro ? "Pro feature" : missing.length ? `Fill in: ${missing.join(", ")}` : undefined
          }
          onClick={() => {
            const { rules } = instantiatePack(pack, vars);
            onInstall(rules);
            setDone(true);
          }}
        >
          {done ? "Install again" : "Install pack"}
        </Button>
        {done ? <span className="rr-small rr-muted">Added to your rules.</span> : null}
      </div>
    </div>
  );
}

export function ProPanel({ pro, syncEnabled, onSyncToggle, onInstallPack }: ProPanelProps) {
  const isPro = pro === true;
  return (
    <div className="rr-stack">
      <LicensePanel />

      <section className="rr-section">
        <h2>{PRO_FEATURES.sync.title}</h2>
        <p className="rr-help">
          {PRO_FEATURES.sync.description} Local storage stays the source of truth; the newest copy
          wins when another device changes rules.
        </p>
        <Toggle
          checked={syncEnabled}
          onChange={onSyncToggle}
          disabled={!isPro}
          label={syncEnabled ? "Sync is on" : "Sync is off"}
        />
      </section>

      <section className="rr-section">
        <h2>{PRO_FEATURES["rule-packs"].title}</h2>
        <p className="rr-help">
          {PRO_FEATURES["rule-packs"].description} Packs are bundled with the extension; installing
          adds ordinary rules you can edit or delete.
        </p>
        <div className="rr-stack">
          {RULE_PACKS.map((pack) => (
            <PackCard key={pack.id} pack={pack} pro={isPro} onInstall={onInstallPack} />
          ))}
        </div>
      </section>

      <section className="rr-section">
        <h2>{PRO_FEATURES.share.title}</h2>
        <p className="rr-help">
          {PRO_FEATURES.share.description} Create links from the Import / Export tab. Importing a
          link is free for everyone.
        </p>
      </section>
    </div>
  );
}

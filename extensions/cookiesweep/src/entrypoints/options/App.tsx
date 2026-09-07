import { useState } from "react";
import { Button, Panel } from "@browserforge/ui";
import { ActivityLogTable } from "../../components/ActivityLogTable.js";
import { ConfirmButton } from "../../components/ConfirmButton.js";
import { ImportExport } from "../../components/ImportExport.js";
import { ListEditor } from "../../components/ListEditor.js";
import { Section } from "../../components/Section.js";
import { StatusPill } from "../../components/StatusPill.js";
import { Toggle } from "../../components/Toggle.js";
import { useCookieStores } from "../../hooks/useCookieStores.js";
import { useActivityLog, useSettings } from "../../hooks/useSettings.js";
import { sendMessage } from "../../lib/messages.js";
import { MAX_DELAY_SECONDS, MIN_DELAY_SECONDS, clampDelay } from "../../lib/settings.js";

function DelayField({
  value,
  disabled,
  onCommit,
}: {
  value: number;
  disabled: boolean;
  onCommit: (seconds: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const next = clampDelay(draft, value);
    setDraft(null);
    if (next !== value) onCommit(next);
  };
  return (
    <div className="cs-field__control">
      <input
        id="cs-delay"
        className="cs-input cs-input--number"
        type="number"
        min={MIN_DELAY_SECONDS}
        max={MAX_DELAY_SECONDS}
        step={1}
        value={draft ?? String(value)}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      <span className="cs-muted cs-small">seconds</span>
    </div>
  );
}

export function App() {
  const { settings, loading, patch } = useSettings();
  const { log, clear } = useActivityLog();
  const stores = useCookieStores();
  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState<string | null>(null);

  const cleanAll = async () => {
    setCleaning(true);
    setCleanResult(null);
    const response = await sendMessage({ type: "clean-all" });
    setCleaning(false);
    if (!response.ok) {
      setCleanResult(`Cleanup failed: ${response.error}`);
      return;
    }
    const s = response.summary;
    setCleanResult(
      s
        ? `Removed ${s.cookiesRemoved} cookie${s.cookiesRemoved === 1 ? "" : "s"} across ${s.domains.length} domain${s.domains.length === 1 ? "" : "s"}${s.siteDataDomains > 0 ? ` and cleared site data for ${s.siteDataDomains}` : ""}.`
        : "Nothing to clean.",
    );
  };

  return (
    <div className="cs-page">
      <Panel
        title="CookieSweep settings"
        actions={
          <>
            <StatusPill
              status={settings.enabled ? "clean" : "paused"}
              label={settings.enabled ? "Active" : "Paused"}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={loading}
              onClick={() => patch({ enabled: !settings.enabled })}
            >
              {settings.enabled ? "Pause" : "Resume"}
            </Button>
          </>
        }
      >
        <Section
          title="Cleanup behaviour"
          description="Cookies for a site are removed after its last tab closes or you navigate away, unless the site is on a list or still open somewhere."
        >
          <Toggle
            label="Automatic cleanup"
            hint="Pause to stop all automatic cleanups. Manual cleanups still work."
            checked={settings.enabled}
            disabled={loading}
            onChange={(enabled) => patch({ enabled })}
          />
          <div className="cs-field">
            <div>
              <label className="cs-field__label" htmlFor="cs-delay">
                Delay before cleaning
              </label>
              <p className="cs-field__hint">
                Seconds to wait after a trigger, so quick tab switches do not log you out. Delays
                under 30 s use a timer that may be lost if the browser suspends the extension.
              </p>
            </div>
            <DelayField
              value={settings.delaySeconds}
              disabled={loading}
              onCommit={(delaySeconds) => patch({ delaySeconds })}
            />
          </div>
          <Toggle
            label="Also clean site data"
            hint="Clears localStorage, IndexedDB, Cache Storage and service workers for cleaned domains."
            checked={settings.cleanSiteData}
            disabled={loading}
            onChange={(cleanSiteData) => patch({ cleanSiteData })}
          />
          <Toggle
            label="Full sweep on browser startup"
            hint="Off: startup only expires the greylist. On: everything not whitelisted or open in a restored tab is cleaned at startup."
            checked={settings.cleanOnStartup}
            disabled={loading}
            onChange={(cleanOnStartup) => patch({ cleanOnStartup })}
          />
          <Toggle
            label="Show a badge flash after each cleanup"
            hint="Briefly shows the number of removed cookies on the toolbar icon. CookieSweep does not use system notifications."
            checked={settings.notifications}
            disabled={loading}
            onChange={(notifications) => patch({ notifications })}
          />
        </Section>

        <Section
          title="Whitelist and greylist"
          description="Whitelisted sites always keep their cookies. Greylisted sites keep them until the browser restarts."
        >
          <ListEditor
            lists={settings.lists}
            stores={stores}
            onChange={(lists) => patch({ lists })}
          />
        </Section>

        <Section
          title="Import and export"
          description="Bring your lists over from Cookie AutoDelete, or back up CookieSweep's lists as JSON."
        >
          <ImportExport lists={settings.lists} onReplace={(lists) => patch({ lists })} />
        </Section>

        <Section
          title="Clean now"
          description="Removes cookies and site data for every domain that is not whitelisted and not open in a tab. Greylisted domains are cleaned too."
        >
          <div className="cs-row">
            <ConfirmButton
              label="Clean everything except whitelist now"
              confirmLabel="Yes, clean now"
              prompt="This signs you out of every site that is not whitelisted or open."
              className="cs-danger"
              busy={cleaning}
              onConfirm={cleanAll}
            />
          </div>
          {cleanResult ? <div className="cs-callout">{cleanResult}</div> : null}
        </Section>

        <Section title="Activity log" description="What CookieSweep removed, and why it ran.">
          <ActivityLogTable entries={log} onClear={clear} />
        </Section>

        <p className="cs-small cs-muted">
          CookieSweep never contacts a server. Host access to all sites is required so cookies can
          be listed and removed for any domain.
        </p>
      </Panel>
    </div>
  );
}

import { Button, copyToClipboard, Panel, ProBadge } from "@browserforge/ui";
import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { allowlistItem, rulesItem, settingsItem } from "../../adapters/storage";
import { loadTrackingRules } from "../../adapters/tracking-rules";
import { Toggle } from "../../components/Toggle";
import { useActiveTabUrl } from "../../hooks/useActiveTabUrl";
import { useBackgroundStatus } from "../../hooks/useBackgroundStatus";
import { usePro } from "../../hooks/usePro";
import { useStorageItem } from "../../hooks/useStorageItem";
import {
  addHostToAllowlist,
  isHostAllowlisted,
  removeHostFromAllowlist,
} from "../../lib/rules/allowlist";
import { cleanUrl, type CleanResult } from "../../lib/tracking/clean";

/** Hostname of an http(s) URL; null for pages Reroute cannot act on. */
function httpHostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";
    return isHttp ? parsed.hostname : null;
  } catch {
    return null;
  }
}

function describeCopy(result: CleanResult): string {
  if (!result.changed) return "Copied. Nothing to remove.";
  const count = result.removed.length;
  return `Copied. Removed ${count} parameter${count === 1 ? "" : "s"}: ${result.removed.join(", ")}`;
}

function pageLabel(host: string | null, tabUrl: string | null): string {
  if (host) return host;
  return tabUrl ? "This page cannot be rerouted" : "No active tab";
}

export function App() {
  const tabUrl = useActiveTabUrl();
  const [rules] = useStorageItem(rulesItem);
  const [allowlist, setAllowlist] = useStorageItem(allowlistItem);
  const [settings] = useStorageItem(settingsItem);
  const { status, refresh: refreshStatus } = useBackgroundStatus(0);
  useEffect(() => refreshStatus(), [refreshStatus]);
  const pro = usePro();
  const [copied, setCopied] = useState<string | null>(null);

  const host = httpHostOf(tabUrl);
  const siteOn = host ? !isHostAllowlisted(host, allowlist) : true;
  const enabledRules = rules.filter((r) => r.enabled).length;

  const toggleSite = (on: boolean) => {
    if (!host) return;
    void setAllowlist(
      on ? removeHostFromAllowlist(allowlist, host) : addHostToAllowlist(allowlist, host),
    );
  };

  const cleanAndCopy = async () => {
    if (!tabUrl) return;
    const trackingRules = settings.trackingEnabled ? await loadTrackingRules() : [];
    const result = cleanUrl(tabUrl, trackingRules);
    const ok = await copyToClipboard(result.url);
    setCopied(ok ? describeCopy(result) : "Clipboard unavailable.");
  };

  return (
    <div className="rr-popup">
      <Panel title="Reroute" actions={pro ? <ProBadge /> : null}>
        <div>
          <div className="rr-popup__host" title={host ?? tabUrl ?? ""}>
            {pageLabel(host, tabUrl)}
          </div>
          {host ? (
            <Toggle
              checked={siteOn}
              onChange={toggleSite}
              label={siteOn ? "Reroute is on for this site" : "Reroute is off for this site"}
            />
          ) : null}
        </div>

        <div>
          <div className="rr-stat">
            <span className="rr-muted">Active rules</span>
            <span>
              {enabledRules}
              {status ? (
                <span className="rr-muted">
                  {" "}
                  ({status.dnrRules} network, {status.jsOnlyRuleIds.length} JS)
                </span>
              ) : null}
            </span>
          </div>
          <div className="rr-stat">
            <span className="rr-muted">Tracking cleaner</span>
            <span>{settings.trackingEnabled ? "On" : "Off"}</span>
          </div>
        </div>

        <div className="rr-stack">
          <Button onClick={() => void cleanAndCopy()} disabled={host === null}>
            Clean &amp; copy current URL
          </Button>
          {copied ? (
            <div className="rr-small rr-muted" role="status">
              {copied}
            </div>
          ) : null}
          <Button variant="secondary" onClick={() => void browser.runtime.openOptionsPage()}>
            Manage rules
          </Button>
        </div>
      </Panel>
    </div>
  );
}

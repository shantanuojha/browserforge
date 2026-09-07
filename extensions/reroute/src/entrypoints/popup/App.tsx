import { hostMatchesAny } from "@browserforge/shared";
import { Button, Panel, ProBadge } from "@browserforge/ui";
import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { Toggle } from "../../components/Toggle";
import { usePro } from "../../hooks/usePro";
import { useStorageItem } from "../../hooks/useStorageItem";
import type { Message, StatusResponse } from "../../lib/messages";
import { allowlistItem, rulesItem, settingsItem } from "../../lib/storage";
import { cleanUrl } from "../../lib/tracking/clean";
import { loadTrackingRules } from "../../lib/tracking/load";

export function App() {
  const [tabUrl, setTabUrl] = useState<string | null>(null);
  const [rules] = useStorageItem(rulesItem);
  const [allowlist, setAllowlist] = useStorageItem(allowlistItem);
  const [settings] = useStorageItem(settingsItem);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const pro = usePro();

  useEffect(() => {
    void browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      setTabUrl(tabs[0]?.url ?? null);
    });
    const msg: Message = { type: "reroute:get-status" };
    browser.runtime
      .sendMessage(msg)
      .then((res: unknown) => {
        if (res && typeof res === "object") setStatus(res as StatusResponse);
      })
      .catch(() => setStatus(null));
  }, []);

  let host: string | null = null;
  let isHttp = false;
  if (tabUrl) {
    try {
      const u = new URL(tabUrl);
      isHttp = u.protocol === "http:" || u.protocol === "https:";
      host = isHttp ? u.hostname : null;
    } catch {
      host = null;
    }
  }

  const siteOn = host ? !hostMatchesAny(host, allowlist) : true;
  const enabledRules = rules.filter((r) => r.enabled).length;

  const toggleSite = (on: boolean) => {
    if (!host) return;
    if (on) {
      void setAllowlist(allowlist.filter((p) => !hostMatchesAny(host as string, [p])));
    } else if (!allowlist.includes(host)) {
      void setAllowlist([...allowlist, host]);
    }
  };

  const cleanAndCopy = async () => {
    if (!tabUrl) return;
    const trackingRules = settings.trackingEnabled ? await loadTrackingRules() : [];
    const result = cleanUrl(tabUrl, trackingRules);
    try {
      await navigator.clipboard.writeText(result.url);
      setCopied(
        result.changed
          ? `Copied. Removed ${result.removed.length} parameter${result.removed.length === 1 ? "" : "s"}: ${result.removed.join(", ")}`
          : "Copied. Nothing to remove.",
      );
    } catch {
      setCopied("Clipboard unavailable.");
    }
  };

  return (
    <div className="rr-popup">
      <Panel title="Reroute" actions={pro ? <ProBadge /> : null}>
        <div>
          <div className="rr-popup__host" title={host ?? tabUrl ?? ""}>
            {host ?? (tabUrl ? "This page cannot be rerouted" : "No active tab")}
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
          <Button onClick={() => void cleanAndCopy()} disabled={!isHttp}>
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

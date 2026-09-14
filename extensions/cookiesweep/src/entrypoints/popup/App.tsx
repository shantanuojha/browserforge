import { useState } from "react";
import { browser } from "wxt/browser";
import { Button, Panel } from "@browserforge/ui";
import { sendMessage } from "../../adapters/messaging.js";
import { StatusPill, type SiteStatus } from "../../components/StatusPill.js";
import { useSettings } from "../../hooks/useSettings.js";
import { useSiteInfo, type SiteInfo } from "../../hooks/useSiteInfo.js";
import type { Message } from "../../lib/messages.js";
import { classifyHost, suggestedPattern } from "../../lib/planner.js";
import {
  addListEntry,
  removeListEntry,
  type ListEntry,
  type ListType,
  type Settings,
} from "../../lib/settings.js";

const LIST_LABEL: Record<ListType, string> = { white: "whitelist", grey: "greylist" };

/** The pill shown for the current site. */
function siteStatus(host: string | null, enabled: boolean, listType: ListType | null): SiteStatus {
  if (!host) return "none";
  if (!enabled) return "paused";
  return listType ?? "clean";
}

/** The entry for this site (by its suggested pattern) that applies in this store, if any. */
function listedEntryFor(
  pattern: string | null,
  storeId: string,
  lists: readonly ListEntry[],
): ListEntry | undefined {
  if (!pattern) return undefined;
  return lists.find((e) => e.pattern === pattern && (!e.storeId || e.storeId === storeId));
}

function cleanSiteMessage(host: string, site: SiteInfo): Message {
  return site.tabId !== undefined
    ? { type: "clean-site", host, tabId: site.tabId }
    : { type: "clean-site", host };
}

function describeSiteClean(removed: number, host: string, settings: Settings): string {
  const siteData = settings.cleanSiteData ? " and site data" : "";
  return `Removed ${removed} cookie${removed === 1 ? "" : "s"}${siteData} for ${host}. Reload the page to see the effect.`;
}

function SiteSummary({
  site,
  host,
  status,
  settings,
  listType,
}: {
  site: SiteInfo | null;
  host: string | null;
  status: SiteStatus;
  settings: Settings;
  listType: ListType | null;
}) {
  const count = site?.cookieCount ?? 0;
  return (
    <div className="cs-popup__site">
      <div className="cs-popup__host">{host ?? "No web page in this tab"}</div>
      <div className="cs-popup__meta">
        <StatusPill status={status} />
        {host ? (
          <span>
            {count} cookie{count === 1 ? "" : "s"} for this site
          </span>
        ) : (
          <span>Cookies only exist for http and https pages.</span>
        )}
      </div>
      {host && listType === null && settings.enabled ? (
        <p className="cs-small cs-muted" style={{ margin: 0 }}>
          Cookies are removed {settings.delaySeconds} s after the last tab for this site closes.
        </p>
      ) : null}
      {host && listType === "grey" ? (
        <p className="cs-small cs-muted" style={{ margin: 0 }}>
          Kept until the browser restarts.
        </p>
      ) : null}
    </div>
  );
}

interface SiteActionsProps {
  hasSite: boolean;
  listedEntry: ListEntry | undefined;
  /** Settings are still loading or a cleanup is running. */
  disabled: boolean;
  busy: boolean;
  onAdd: (type: ListType) => void;
  onRemove: () => void;
  onClean: () => void;
}

function SiteActions({
  hasSite,
  listedEntry,
  disabled,
  busy,
  onAdd,
  onRemove,
  onClean,
}: SiteActionsProps) {
  return (
    <div className="cs-popup__actions">
      {listedEntry ? (
        <Button className="cs-span2" variant="secondary" disabled={disabled} onClick={onRemove}>
          Remove from {LIST_LABEL[listedEntry.listType]}
        </Button>
      ) : (
        <>
          <Button disabled={!hasSite || disabled} onClick={() => onAdd("white")}>
            Add to whitelist
          </Button>
          <Button variant="secondary" disabled={!hasSite || disabled} onClick={() => onAdd("grey")}>
            Add to greylist
          </Button>
        </>
      )}
      <Button
        className="cs-span2 cs-danger"
        variant="secondary"
        disabled={!hasSite || busy}
        onClick={onClean}
      >
        {busy ? "Cleaning..." : "Clean this site now"}
      </Button>
    </div>
  );
}

export function App() {
  const { settings, loading, patch } = useSettings();
  const { site, refresh } = useSiteInfo();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const host = site?.host ?? null;
  const storeId = site?.storeId ?? "0";
  const listType = host ? classifyHost(host, storeId, settings.lists) : null;
  const status = siteStatus(host, settings.enabled, listType);
  const pattern = host ? suggestedPattern(host) : null;
  const listedEntry = listedEntryFor(pattern, storeId, settings.lists);

  const addTo = async (type: ListType) => {
    if (!pattern) return;
    await patch({ lists: addListEntry(settings.lists, { pattern, listType: type }) });
    setMessage(`${pattern} added to the ${LIST_LABEL[type]}.`);
    void sendMessage({ type: "refresh-badge" });
  };

  const removeFromList = async () => {
    if (!listedEntry) return;
    await patch({ lists: removeListEntry(settings.lists, listedEntry) });
    setMessage(`${listedEntry.pattern} removed from your lists.`);
    void sendMessage({ type: "refresh-badge" });
  };

  const cleanSite = async () => {
    if (!host || !site) return;
    setBusy(true);
    setMessage(null);
    const response = await sendMessage(cleanSiteMessage(host, site));
    setBusy(false);
    setMessage(
      response.ok
        ? describeSiteClean(response.summary?.cookiesRemoved ?? 0, host, settings)
        : `Cleanup failed: ${response.error}`,
    );
    await refresh();
  };

  const togglePause = async () => {
    await patch({ enabled: !settings.enabled });
    void sendMessage({ type: "refresh-badge" });
  };

  const openSettings = () => {
    void browser.runtime.openOptionsPage();
    window.close();
  };

  return (
    <div className="cs-popup">
      <Panel title="CookieSweep" actions={settings.enabled ? null : <StatusPill status="paused" />}>
        <SiteSummary
          site={site}
          host={host}
          status={status}
          settings={settings}
          listType={listType}
        />

        <SiteActions
          hasSite={host !== null}
          listedEntry={listedEntry}
          disabled={loading || busy}
          busy={busy}
          onAdd={(type) => void addTo(type)}
          onRemove={() => void removeFromList()}
          onClean={() => void cleanSite()}
        />

        {message ? (
          <div className="cs-callout" role="status">
            {message}
          </div>
        ) : null}

        <div className="cs-popup__footer">
          <Button size="sm" variant="ghost" disabled={loading} onClick={togglePause}>
            {settings.enabled ? "Pause CookieSweep" : "Resume CookieSweep"}
          </Button>
          <Button size="sm" variant="ghost" onClick={openSettings}>
            Open settings
          </Button>
        </div>
      </Panel>
    </div>
  );
}

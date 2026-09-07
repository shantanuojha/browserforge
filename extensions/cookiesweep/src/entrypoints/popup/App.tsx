import { useCallback, useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { Button, Panel } from "@browserforge/ui";
import { StatusPill, type SiteStatus } from "../../components/StatusPill.js";
import { useSettings } from "../../hooks/useSettings.js";
import { countCookiesForHost } from "../../lib/executor.js";
import { createExecutorApi, getActiveTab, storeIdForTab, tabUrl } from "../../lib/extension-api.js";
import { sendMessage } from "../../lib/messages.js";
import { classifyHost, hostFromTabUrl, suggestedPattern } from "../../lib/planner.js";
import { addListEntry, removeListEntry, type ListType } from "../../lib/settings.js";

interface SiteInfo {
  tabId?: number;
  host: string | null;
  storeId: string;
  cookieCount: number;
}

async function readSite(): Promise<SiteInfo> {
  const tab = await getActiveTab();
  const host = hostFromTabUrl(tabUrl(tab));
  const storeId = await storeIdForTab(tab?.id);
  const cookieCount = host ? await countCookiesForHost(createExecutorApi(), storeId, host) : 0;
  const info: SiteInfo = { host, storeId, cookieCount };
  if (tab?.id !== undefined) info.tabId = tab.id;
  return info;
}

export function App() {
  const { settings, loading, patch } = useSettings();
  const [site, setSite] = useState<SiteInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const info = await readSite().catch((): SiteInfo => ({
      host: null,
      storeId: "0",
      cookieCount: 0,
    }));
    setSite(info);
  }, []);

  useEffect(() => {
    let cancelled = false;
    readSite()
      .catch((): SiteInfo => ({ host: null, storeId: "0", cookieCount: 0 }))
      .then((info) => {
        if (!cancelled) setSite(info);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const host = site?.host ?? null;
  const listType: ListType | null = host
    ? classifyHost(host, site?.storeId ?? "0", settings.lists)
    : null;
  const status: SiteStatus = !host
    ? "none"
    : !settings.enabled
      ? "paused"
      : listType === "white"
        ? "white"
        : listType === "grey"
          ? "grey"
          : "clean";

  const pattern = host ? suggestedPattern(host) : null;
  const listedEntry = host
    ? settings.lists.find(
        (e) => e.pattern === pattern && (!e.storeId || e.storeId === site?.storeId),
      )
    : undefined;

  const addTo = async (type: ListType) => {
    if (!pattern) return;
    await patch({ lists: addListEntry(settings.lists, { pattern, listType: type }) });
    setMessage(`${pattern} added to the ${type === "white" ? "whitelist" : "greylist"}.`);
    void sendMessage({ type: "refresh-badge" });
  };

  const removeFromList = async () => {
    if (!listedEntry) return;
    await patch({ lists: removeListEntry(settings.lists, listedEntry) });
    setMessage(`${listedEntry.pattern} removed from your lists.`);
    void sendMessage({ type: "refresh-badge" });
  };

  const cleanSite = async () => {
    if (!host) return;
    setBusy(true);
    setMessage(null);
    const msg =
      site?.tabId !== undefined
        ? ({ type: "clean-site", host, tabId: site.tabId } as const)
        : ({ type: "clean-site", host } as const);
    const response = await sendMessage(msg);
    setBusy(false);
    if (!response.ok) {
      setMessage(`Cleanup failed: ${response.error}`);
    } else {
      const n = response.summary?.cookiesRemoved ?? 0;
      setMessage(
        `Removed ${n} cookie${n === 1 ? "" : "s"}${settings.cleanSiteData ? " and site data" : ""} for ${host}. Reload the page to see the effect.`,
      );
    }
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
        <div className="cs-popup__site">
          <div className="cs-popup__host">{host ?? "No web page in this tab"}</div>
          <div className="cs-popup__meta">
            <StatusPill status={status} />
            {host ? (
              <span>
                {site?.cookieCount ?? 0} cookie{site?.cookieCount === 1 ? "" : "s"} for this site
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

        <div className="cs-popup__actions">
          {listedEntry ? (
            <Button
              className="cs-span2"
              variant="secondary"
              disabled={loading || busy}
              onClick={removeFromList}
            >
              Remove from {listedEntry.listType === "white" ? "whitelist" : "greylist"}
            </Button>
          ) : (
            <>
              <Button disabled={!host || loading || busy} onClick={() => addTo("white")}>
                Add to whitelist
              </Button>
              <Button
                variant="secondary"
                disabled={!host || loading || busy}
                onClick={() => addTo("grey")}
              >
                Add to greylist
              </Button>
            </>
          )}
          <Button
            className="cs-span2 cs-danger"
            variant="secondary"
            disabled={!host || busy}
            onClick={cleanSite}
          >
            {busy ? "Cleaning..." : "Clean this site now"}
          </Button>
        </div>

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

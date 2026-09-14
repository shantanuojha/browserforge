import { useCallback, useEffect, useState } from "react";
import {
  createExecutorApi,
  getActiveTab,
  storeIdForTab,
  tabUrl,
} from "../adapters/extension-api.js";
import { countCookiesForHost } from "../lib/executor.js";
import { hostFromTabUrl } from "../lib/planner.js";

export interface SiteInfo {
  tabId?: number;
  /** Null for tabs that cannot own cookies. */
  host: string | null;
  storeId: string;
  cookieCount: number;
}

const NO_SITE: SiteInfo = { host: null, storeId: "0", cookieCount: 0 };

async function readSite(): Promise<SiteInfo> {
  const tab = await getActiveTab();
  const host = hostFromTabUrl(tabUrl(tab));
  const storeId = await storeIdForTab(tab?.id);
  const cookieCount = host ? await countCookiesForHost(createExecutorApi(), storeId, host) : 0;
  const info: SiteInfo = { host, storeId, cookieCount };
  if (tab?.id !== undefined) info.tabId = tab.id;
  return info;
}

/** The active tab's site and cookie count; `null` until the first read resolves. */
export function useSiteInfo(): { site: SiteInfo | null; refresh: () => Promise<void> } {
  const [site, setSite] = useState<SiteInfo | null>(null);
  const refresh = useCallback(async () => {
    setSite(await readSite().catch(() => NO_SITE));
  }, []);

  useEffect(() => {
    let cancelled = false;
    readSite()
      .catch(() => NO_SITE)
      .then((info) => {
        if (!cancelled) setSite(info);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { site, refresh };
}

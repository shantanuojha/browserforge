import { useEffect, useState } from "react";
import { browser } from "wxt/browser";

/** URL of the active tab in the current window; `null` until known or when there is none. */
export function useActiveTabUrl(): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      if (!cancelled) setUrl(tabs[0]?.url ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return url;
}

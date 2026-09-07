import { useEffect, useState } from "react";
import { getCookieStores } from "../lib/extension-api.js";

/** Ids of the cookie stores the browser currently exposes (containers, incognito). */
export function useCookieStores(): string[] {
  const [stores, setStores] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void getCookieStores().then((list) => {
      if (!cancelled) setStores(list.map((s) => s.id));
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return stores;
}

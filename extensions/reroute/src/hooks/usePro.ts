import { useEffect, useState } from "react";
import { isPro } from "../lib/pro";

/** null while unknown, then the entitlement. */
export function usePro(): boolean | null {
  const [pro, setPro] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void isPro().then((v) => {
      if (!cancelled) setPro(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return pro;
}

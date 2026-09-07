import { useEffect, useState } from "react";
import { isPro } from "@/lib/pro";

/** `null` while the entitlement check is in flight. */
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

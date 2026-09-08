import { useEffect, useState } from "react";
import { onLicenseChange } from "@/lib/licensing";
import { isPro } from "@/lib/pro";

/** `null` while the entitlement check is in flight; re-checks whenever the licence changes. */
export function usePro(): boolean | null {
  const [pro, setPro] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    const check = () =>
      void isPro().then((v) => {
        if (!cancelled) setPro(v);
      });
    check();
    const unsubscribe = onLicenseChange(check);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return pro;
}

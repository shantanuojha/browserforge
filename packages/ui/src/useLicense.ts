import { useCallback, useEffect, useState } from "react";
import { isProState, type LicenseClient, type LicenseState } from "@browserforge/licensing";

export interface UseLicenseResult {
  /** `null` until the first read from storage resolves. */
  state: LicenseState | null;
  isPro: boolean;
  /** Force a network revalidation and return the resulting state. */
  refresh: () => Promise<LicenseState>;
}

/** Subscribes to a licence client and re-renders on every state change. */
export function useLicense(client: LicenseClient): UseLicenseResult {
  const [state, setState] = useState<LicenseState | null>(null);

  useEffect(() => {
    let live = true;
    const unsubscribe = client.onChange((next) => {
      if (live) setState(next);
    });
    void client.getState().then((current) => {
      if (live) setState(current);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [client]);

  const refresh = useCallback(() => client.validate({ force: true }), [client]);

  return { state, isPro: isProState(state), refresh };
}

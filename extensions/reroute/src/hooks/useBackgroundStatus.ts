import { useCallback, useState } from "react";
import { browser } from "wxt/browser";
import type { Message, StatusResponse } from "../lib/messages";

/** Give the background a moment to recompile after a storage change before asking. */
export const STATUS_SETTLE_MS = 250;

async function fetchStatus(): Promise<StatusResponse | null> {
  const message: Message = { type: "reroute:get-status" };
  try {
    const response: unknown = await browser.runtime.sendMessage(message);
    return response && typeof response === "object" ? (response as StatusResponse) : null;
  } catch {
    return null;
  }
}

export interface BackgroundStatus {
  status: StatusResponse | null;
  /**
   * Schedules a fetch after `delayMs`; returns a cancel function, so it can be the body of a
   * `useEffect` keyed on the values whose storage writes make the background rebuild.
   */
  refresh: () => () => void;
}

/** The background's view of the rule set (network vs JavaScript rules, last error). */
export function useBackgroundStatus(delayMs = STATUS_SETTLE_MS): BackgroundStatus {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const refresh = useCallback(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void fetchStatus().then((next) => {
        if (!cancelled) setStatus(next);
      });
    }, delayMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [delayMs]);
  return { status, refresh };
}

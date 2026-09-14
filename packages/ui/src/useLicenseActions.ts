import { useState } from "react";
import type { LicenseClient, LicenseState } from "@browserforge/licensing";
import type { CalloutTone } from "./Callout.js";
import { hasRestorableKey } from "./licenseSummary.js";
import { openExternal } from "./ProGate.js";

export type LicenseBusy = "activate" | "deactivate" | "restore" | null;

export interface LicenseNotice {
  tone: CalloutTone;
  text: string;
}

export interface LicenseActions {
  busy: LicenseBusy;
  notice: LicenseNotice | null;
  activate(key: string): Promise<boolean>;
  deactivate(): Promise<void>;
  /** Re-validates a stored key, or opens `restoreUrl` when there is nothing to re-validate. */
  restore(): Promise<void>;
}

interface LicenseActionsInput {
  client: LicenseClient;
  state: LicenseState | null;
  refresh: () => Promise<LicenseState>;
  restoreUrl: string;
}

function restoreNotice(next: LicenseState): LicenseNotice | null {
  if (next.kind === "pro") return { tone: "success", text: "Your purchase was restored." };
  if (next.kind === "grace") {
    return { tone: "warning", text: "Could not reach the licence server. Try again later." };
  }
  return null;
}

/** The activate / deactivate / restore flows with their busy and notice state. */
export function useLicenseActions({
  client,
  state,
  refresh,
  restoreUrl,
}: LicenseActionsInput): LicenseActions {
  const [busy, setBusy] = useState<LicenseBusy>(null);
  const [notice, setNotice] = useState<LicenseNotice | null>(null);

  /** Runs one flow at a time; the notice is cleared at the start and set from the outcome. */
  async function run<T>(
    kind: Exclude<LicenseBusy, null>,
    flow: () => Promise<T>,
  ): Promise<T | undefined> {
    if (busy) return undefined;
    setBusy(kind);
    setNotice(null);
    try {
      return await flow();
    } finally {
      setBusy(null);
    }
  }

  return {
    busy,
    notice,
    async activate(key) {
      const activated = await run("activate", async () => {
        const result = await client.activate(key);
        if (result.ok) setNotice({ tone: "success", text: "Pro activated in this browser." });
        else setNotice({ tone: "danger", text: result.error.message });
        return result.ok;
      });
      return activated === true;
    },
    async deactivate() {
      await run("deactivate", async () => {
        const result = await client.deactivate();
        setNotice(
          result.ok
            ? {
                tone: "info",
                text: "This browser was deactivated. The seat is free for another profile.",
              }
            : { tone: "danger", text: result.error.message },
        );
      });
    },
    async restore() {
      if (!hasRestorableKey(state)) {
        openExternal(restoreUrl);
        return;
      }
      await run("restore", async () => setNotice(restoreNotice(await refresh())));
    },
  };
}

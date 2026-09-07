import { useEffect, useState } from "react";
import { getEntitlements } from "@browserforge/licensing";
import type { Entitlements } from "@browserforge/licensing";
import { Button, Panel, ProBadge } from "@browserforge/ui";

export function App() {
  const [entitlements, setEntitlements] = useState<Entitlements | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getEntitlements().then((e) => {
      if (!cancelled) setEntitlements(e);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Panel title="Arbor" actions={entitlements?.pro ? <ProBadge /> : null}>
      <p>Tree-style tab and session manager. This extension is in development.</p>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          void chrome.runtime.openOptionsPage();
        }}
      >
        Open options
      </Button>
    </Panel>
  );
}

import { useState } from "react";
import { errorMessage } from "@browserforge/shared";
import { Button, Panel, ProBadge } from "@browserforge/ui";
import { msg } from "@/adapters/messaging";
import { currentWindowId, openExtensionPage, openOptionsPage } from "@/adapters/runtime";
import { hasSidePanel } from "@/adapters/side-panel";
import { usePro } from "@/hooks/usePro";

/**
 * Small launcher. In Chrome the toolbar icon opens the side panel directly (see background), so
 * this popup is mostly seen in browsers without a side panel API.
 */
export function App() {
  const pro = usePro();
  const [error, setError] = useState<string | null>(null);

  const openInTab = async () => {
    await openExtensionPage("/sidepanel.html");
    window.close();
  };

  const openPanel = async () => {
    try {
      const opened = await msg.openSidePanel.send({ windowId: await currentWindowId() });
      if (opened) {
        window.close();
        return;
      }
      await openInTab();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Panel title="Arbor" actions={pro ? <ProBadge /> : null} className="launcher">
      <p>Your windows and tabs as a tree that never forgets.</p>
      {hasSidePanel ? (
        <Button size="sm" onClick={() => void openPanel()}>
          Open side panel
        </Button>
      ) : null}
      <Button
        size="sm"
        variant={hasSidePanel ? "secondary" : "primary"}
        onClick={() => void openInTab()}
      >
        Open tree in a tab
      </Button>
      <Button size="sm" variant="ghost" onClick={openOptionsPage}>
        Options
      </Button>
      {error ? <p className="notice notice--error">{error}</p> : null}
    </Panel>
  );
}

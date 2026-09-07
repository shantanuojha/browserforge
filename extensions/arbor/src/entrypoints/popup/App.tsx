import { useState } from "react";
import { browser } from "wxt/browser";
import { Button, Panel, ProBadge } from "@browserforge/ui";
import { usePro } from "@/hooks/usePro";
import { msg } from "@/lib/messages";

const hasSidePanel = "sidePanel" in browser;

/**
 * Small launcher. In Chrome the toolbar icon opens the side panel directly (see background), so
 * this popup is mostly seen in browsers without a side panel API.
 */
export function App() {
  const pro = usePro();
  const [error, setError] = useState<string | null>(null);

  const openPanel = async () => {
    try {
      const win = await browser.windows.getCurrent();
      const opened = await msg.openSidePanel.send({ windowId: win.id });
      if (opened) {
        window.close();
        return;
      }
      await openInTab();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const openInTab = async () => {
    await browser.tabs.create({ url: browser.runtime.getURL("/sidepanel.html") });
    window.close();
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
      <Button size="sm" variant="ghost" onClick={() => void browser.runtime.openOptionsPage()}>
        Options
      </Button>
      {error ? <p className="notice notice--error">{error}</p> : null}
    </Panel>
  );
}

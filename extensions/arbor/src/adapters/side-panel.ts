/**
 * The side panel and the toolbar icon. `browser.sidePanel` only exists in Chromium 114+, and the
 * action API is `action` (MV3) or `browserAction` (MV2), so everything here feature-detects.
 */
import { browser } from "wxt/browser";

type SidePanelApi = typeof browser.sidePanel;
type ActionApi = typeof browser.action;

export function sidePanelApi(): SidePanelApi | undefined {
  const api = (browser as { sidePanel?: SidePanelApi }).sidePanel;
  return api && typeof api.open === "function" ? api : undefined;
}

function actionApi(): ActionApi | undefined {
  const b = browser as unknown as { action?: ActionApi; browserAction?: ActionApi };
  return b.action ?? b.browserAction;
}

/** Whether this browser has a side panel at all (pages use it to decide what to offer). */
export const hasSidePanel = "sidePanel" in browser;

/** Open the side panel in `windowId`; `false` when this browser has no side panel. */
export async function openSidePanel(windowId: number): Promise<boolean> {
  const api = sidePanelApi();
  if (!api) return false;
  await api.open({ windowId });
  return true;
}

/**
 * Chrome: the icon toggles the side panel directly and the popup is disabled (it is only for
 * browsers without a side panel). Clicking falls back to `openOptions` where no panel can open.
 */
export function installToolbarAction(openOptions: () => void): void {
  const sidePanel = sidePanelApi();
  const action = actionApi();
  if (sidePanel && action) {
    void sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
    void action.setPopup({ popup: "" }).catch(() => undefined);
  }
  action?.onClicked.addListener((tab) => {
    if (sidePanel && tab.windowId !== undefined) {
      void sidePanel.open({ windowId: tab.windowId }).catch(openOptions);
    } else {
      openOptions();
    }
  });
}

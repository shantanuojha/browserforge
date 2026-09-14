/**
 * The request/response API the pages use, as tables from message definition to handler. Every
 * handler waits for startup (`whenReady`) so a panel that opens early sees the loaded tree.
 */
import { messages } from "../messages";
import type { MessageDef, MessageRouter } from "../messaging";
import type { ArborBackground } from "./service";

export interface PanelPort {
  /** Open the side panel in `windowId`, or the current window; `false` when unsupported. */
  openSidePanel(windowId: number | undefined): Promise<boolean>;
}

/** Pairs a message definition with its handler; the router does the type checking. */
type Registration = <Req, Res>(
  def: MessageDef<Req, Res>,
  handler: (req: Req) => Promise<Res> | Res,
) => void;

/** Reading and editing the tree, plus everything the tracker does with the browser. */
function treeHandlers(on: Registration, service: ArborBackground): void {
  const { store, tracker } = service;
  on(messages.getState, () => service.currentState());
  on(messages.getStartupInfo, () => service.startup);
  on(messages.applyOps, (bodies) => store.append(bodies));
  on(messages.moveNode, ({ id, parentId, index }) => tracker.moveNode(id, parentId, index));
  on(messages.focusNode, ({ id }) => tracker.focus(id));
  on(messages.restoreNode, ({ id }) => tracker.restore(id));
  on(messages.reopenAll, ({ id }) => tracker.reopenAll(id));
  on(messages.closeAndSave, ({ id }) => tracker.closeAndSave(id));
  on(messages.closeAllAndSave, () => tracker.closeAllAndSave());
  on(messages.deleteNode, ({ id }) => tracker.deleteNode(id));
  on(messages.addNode, (input) => service.addNode(input));
  on(messages.applyHistoryStep, (step) => tracker.runHistoryStep(step));
}

/** Snapshots, quarantine, export and import. */
function storeHandlers(on: Registration, service: ArborBackground): void {
  const { store } = service;
  on(messages.listSnapshots, () => store.listSnapshots());
  on(messages.restoreSnapshot, ({ seq }) => service.restoreSnapshot(seq));
  on(messages.listQuarantine, () => store.listQuarantine());
  on(messages.compactNow, () => service.compactNow());
  on(messages.exportTree, () => service.exportTree());
  on(messages.importNodes, ({ nodes, mode }) => service.importNodes(nodes, mode));
}

/** Pro backups and the side panel launcher. */
function backupAndPanelHandlers(
  on: Registration,
  service: ArborBackground,
  panel: PanelPort,
): void {
  const { backups } = service;
  on(messages.listBackups, () => backups.list());
  on(messages.runBackupNow, () => service.runBackupNow());
  on(messages.getBackup, async ({ ts }) => (await backups.get(ts))?.data ?? null);
  on(messages.deleteBackup, ({ ts }) => backups.delete(ts));
  on(messages.openSidePanel, ({ windowId }) => panel.openSidePanel(windowId));
}

export function registerMessageHandlers(
  router: MessageRouter,
  service: ArborBackground,
  panel: PanelPort,
): MessageRouter {
  const on: Registration = (def, handler) => {
    router.on(def, (req) => service.whenReady(() => handler(req)));
  };
  treeHandlers(on, service);
  storeHandlers(on, service);
  backupAndPanelHandlers(on, service, panel);
  return router;
}

/**
 * The request/response API the pages use, as a table from message definition to handler. Every
 * handler waits for startup (`whenReady`) so a panel that opens early sees the loaded tree.
 */
import { messages } from "../messages";
import type { MessageRouter } from "../messaging";
import type { ArborBackground } from "./service";

export interface PanelPort {
  /** Open the side panel in `windowId`, or the current window; `false` when unsupported. */
  openSidePanel(windowId: number | undefined): Promise<boolean>;
}

export function registerMessageHandlers(
  router: MessageRouter,
  service: ArborBackground,
  panel: PanelPort,
): MessageRouter {
  const { store, tracker, backups } = service;
  const gated =
    <Req, Res>(fn: (req: Req) => Promise<Res> | Res) =>
    (req: Req) =>
      service.whenReady(() => fn(req));

  return router
    .on(
      messages.getState,
      gated(() => service.currentState()),
    )
    .on(
      messages.getStartupInfo,
      gated(() => service.startup),
    )
    .on(
      messages.applyOps,
      gated((bodies) => store.append(bodies)),
    )
    .on(
      messages.moveNode,
      gated(({ id, parentId, index }) => tracker.moveNode(id, parentId, index)),
    )
    .on(
      messages.focusNode,
      gated(({ id }) => tracker.focus(id)),
    )
    .on(
      messages.restoreNode,
      gated(({ id }) => tracker.restore(id)),
    )
    .on(
      messages.reopenAll,
      gated(({ id }) => tracker.reopenAll(id)),
    )
    .on(
      messages.closeAndSave,
      gated(({ id }) => tracker.closeAndSave(id)),
    )
    .on(
      messages.closeAllAndSave,
      gated(() => tracker.closeAllAndSave()),
    )
    .on(
      messages.deleteNode,
      gated(({ id }) => tracker.deleteNode(id)),
    )
    .on(
      messages.addNode,
      gated((input) => service.addNode(input)),
    )
    .on(
      messages.applyHistoryStep,
      gated((step) => tracker.runHistoryStep(step)),
    )
    .on(
      messages.listSnapshots,
      gated(() => store.listSnapshots()),
    )
    .on(
      messages.restoreSnapshot,
      gated(({ seq }) => service.restoreSnapshot(seq)),
    )
    .on(
      messages.listQuarantine,
      gated(() => store.listQuarantine()),
    )
    .on(
      messages.compactNow,
      gated(() => service.compactNow()),
    )
    .on(
      messages.exportTree,
      gated(() => service.exportTree()),
    )
    .on(
      messages.importNodes,
      gated(({ nodes, mode }) => service.importNodes(nodes, mode)),
    )
    .on(
      messages.listBackups,
      gated(() => backups.list()),
    )
    .on(
      messages.runBackupNow,
      gated(() => service.runBackupNow()),
    )
    .on(
      messages.getBackup,
      gated(async ({ ts }) => (await backups.get(ts))?.data ?? null),
    )
    .on(
      messages.deleteBackup,
      gated(({ ts }) => backups.delete(ts)),
    )
    .on(
      messages.openSidePanel,
      gated(({ windowId }) => panel.openSidePanel(windowId)),
    );
}

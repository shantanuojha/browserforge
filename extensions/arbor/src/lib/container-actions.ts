/**
 * The one definition of what a *container* row can do. A container is a `window` node, bound to
 * an open browser window or not; what the UI calls a group is an unbound container the user
 * named. Both the hover buttons on a tree row and its context menu render from the list this
 * module produces, so every container offers the same actions with the same icons, disabled
 * states and handlers, and only the labels reflect whether its window is open right now.
 *
 * Pure: no DOM, no `browser.*`. The handlers are injected; the UI decides how to run them.
 */

import {
  buildChildIndex,
  containerTabs,
  descendantIds,
  isBound,
  type ChildIndex,
  type NodeId,
  type Tree,
  type TreeNode,
} from "./model";

export type ContainerNode = TreeNode & { kind: "window" };

export function isContainer(node: TreeNode): node is ContainerNode {
  return node.kind === "window";
}

export interface ContainerSummary {
  /**
   * Closed tab nodes with a url in the container's own subtree (nested containers left out):
   * the ones "Reopen all" opens.
   */
  savedTabs: number;
  /**
   * Open tab nodes anywhere beneath the container, nested containers included: the ones "Close
   * all and save" closes (a nested container's window closes with its parent's).
   */
  liveTabs: number;
  /** Open tabs of the container's own subtree that sit in another browser window (or in none). */
  liveElsewhere: number;
  /** Direct children, of any kind. */
  children: number;
  /** The container mirrors an open browser window. */
  bound: boolean;
}

/** Open tab nodes anywhere beneath `node`, nested containers included. */
function countLiveTabsBeneath(tree: Tree, node: TreeNode, index: ChildIndex): number {
  let liveTabs = 0;
  for (const id of descendantIds(tree, node.id, index)) {
    const n = tree.get(id);
    if (n?.kind === "tab" && n.liveTabId !== undefined) liveTabs++;
  }
  return liveTabs;
}

/** A live tab of the container that is not in its window: open elsewhere, or the container is closed. */
function isOpenElsewhere(container: TreeNode, tab: TreeNode): boolean {
  return container.liveWindowId === undefined || tab.liveWindowId !== container.liveWindowId;
}

export function summarizeContainer(
  tree: Tree,
  node: TreeNode,
  index: ChildIndex = buildChildIndex(tree),
): ContainerSummary {
  let savedTabs = 0;
  let liveElsewhere = 0;
  for (const n of containerTabs(tree, node.id, index)) {
    if (n.liveTabId === undefined) {
      if (n.url) savedTabs++;
    } else if (isOpenElsewhere(node, n)) {
      liveElsewhere++;
    }
  }
  return {
    savedTabs,
    liveTabs: countLiveTabsBeneath(tree, node, index),
    liveElsewhere,
    children: index.get(node.id)?.length ?? 0,
    bound: isBound(node),
  };
}

export type ContainerActionId =
  "reopen" | "closeAndSave" | "note" | "rename" | "collapse" | "delete";

/** Icons the row buttons use; a subset of `IconName` kept here so this module stays DOM-free. */
export type ContainerActionIcon = "restore" | "close" | "note" | "rename" | "chevron" | "trash";

/** Menu sections, in display order; the menu draws a separator between them. */
export type ContainerActionSection = "open" | "edit" | "danger";

export interface ContainerAction {
  id: ContainerActionId;
  label: string;
  icon: ContainerActionIcon;
  section: ContainerActionSection;
  shortcut?: string | undefined;
  danger?: boolean | undefined;
  disabled: boolean;
  /** Also shown as a hover button on the row (the rest are context-menu / keyboard only). */
  inRow: boolean;
  run(): void;
}

/** What the UI must be able to do for a container; each receives the container's id. */
export interface ContainerActionHandlers {
  reopenAll(id: NodeId): void;
  closeAndSave(id: NodeId): void;
  editNote(id: NodeId): void;
  startRename(id: NodeId): void;
  toggleCollapse(id: NodeId, collapsed: boolean): void;
  deleteNode(id: NodeId): void;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `label`, or `label (detail)` when there is a detail to show. */
function withDetail(label: string, detail: string): string {
  return detail ? `${label} (${detail})` : label;
}

/**
 * "Reopen all" on a bound container opens its closed tabs into that window; on an unbound one it
 * opens a new window holding its closed tabs and gathers in the ones open elsewhere, so it is
 * available as soon as the container holds any tab at all.
 */
function reopenAction(
  s: ContainerSummary,
  id: NodeId,
  handlers: ContainerActionHandlers,
): ContainerAction {
  const counts = [s.savedTabs ? plural(s.savedTabs, "saved tab") : ""];
  if (!s.bound) counts.push(s.liveElsewhere ? plural(s.liveElsewhere, "open tab") : "");
  return {
    id: "reopen",
    label: withDetail(s.bound ? "Reopen all" : "Open as window", counts.filter(Boolean).join(", ")),
    icon: "restore",
    section: "open",
    shortcut: s.bound ? undefined : "Enter",
    disabled: !(s.savedTabs > 0 || (!s.bound && s.liveElsewhere > 0)),
    inRow: true,
    run: () => handlers.reopenAll(id),
  };
}

function closeAction(
  s: ContainerSummary,
  id: NodeId,
  handlers: ContainerActionHandlers,
): ContainerAction {
  const label = s.bound ? "Close window and save" : "Close all and save";
  return {
    id: "closeAndSave",
    label: withDetail(label, s.liveTabs ? plural(s.liveTabs, "open tab") : ""),
    icon: "close",
    section: "open",
    shortcut: "Del",
    disabled: s.liveTabs === 0,
    inRow: true,
    run: () => handlers.closeAndSave(id),
  };
}

function editActions(
  s: ContainerSummary,
  node: ContainerNode,
  handlers: ContainerActionHandlers,
): ContainerAction[] {
  const id = node.id;
  return [
    {
      id: "note",
      label: node.note ? "Edit note" : "Add note",
      icon: "note",
      section: "edit",
      shortcut: "N",
      disabled: false,
      inRow: true,
      run: () => handlers.editNote(id),
    },
    {
      id: "rename",
      label: "Rename",
      icon: "rename",
      section: "edit",
      shortcut: "F2",
      disabled: false,
      inRow: false,
      run: () => handlers.startRename(id),
    },
    {
      id: "collapse",
      label: node.collapsed ? "Expand" : "Collapse",
      icon: "chevron",
      section: "edit",
      shortcut: "Space",
      disabled: s.children === 0,
      inRow: false,
      run: () => handlers.toggleCollapse(id, !node.collapsed),
    },
  ];
}

function deleteAction(
  s: ContainerSummary,
  id: NodeId,
  handlers: ContainerActionHandlers,
): ContainerAction {
  return {
    id: "delete",
    label: s.liveTabs ? `Delete (closes ${plural(s.liveTabs, "open tab")})` : "Delete",
    icon: "trash",
    section: "danger",
    danger: true,
    disabled: false,
    inRow: true,
    run: () => handlers.deleteNode(id),
  };
}

/**
 * Actions for a container node, in menu order. Disabled entries are still returned so a menu
 * can show them greyed out; row buttons typically hide them (`inRow && !disabled`).
 */
export function containerActions(
  tree: Tree,
  node: ContainerNode,
  handlers: ContainerActionHandlers,
  index: ChildIndex = buildChildIndex(tree),
): ContainerAction[] {
  const s = summarizeContainer(tree, node, index);
  return [
    reopenAction(s, node.id, handlers),
    closeAction(s, node.id, handlers),
    ...editActions(s, node, handlers),
    deleteAction(s, node.id, handlers),
  ];
}

/**
 * What the Delete key does on a container: close-and-save while anything beneath it is open
 * (like a live window has always behaved), delete otherwise.
 */
export function deleteKeyAction(actions: ContainerAction[]): ContainerAction | undefined {
  const close = actions.find((a) => a.id === "closeAndSave");
  return close && !close.disabled ? close : actions.find((a) => a.id === "delete");
}

/**
 * The one row button that stays visible without hovering: "Reopen" on a container that holds
 * saved tabs and nothing open (a closed window, a group whose tabs were all closed and saved).
 * The other buttons only appear on hover, focus or selection; a closed container's main purpose
 * is to be reopened, so that action must be discoverable at a glance.
 */
export function pinnedContainerAction(actions: ContainerAction[]): ContainerAction | undefined {
  const reopen = actions.find((a) => a.id === "reopen");
  const close = actions.find((a) => a.id === "closeAndSave");
  if (!reopen || reopen.disabled) return undefined;
  if (close && !close.disabled) return undefined;
  return reopen;
}

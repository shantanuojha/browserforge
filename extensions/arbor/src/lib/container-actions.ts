/**
 * The one definition of what a *container* row (a window node, live or saved, or a user group)
 * can do. Both the hover buttons on a tree row and its context menu render from the list this
 * module produces, so a Window row and a Group row are guaranteed to offer the same actions with
 * the same labels, icons, disabled states and handlers.
 *
 * Pure: no DOM, no `browser.*`. The handlers are injected; the UI decides how to run them.
 */

import {
  buildChildIndex,
  descendantIds,
  type ChildIndex,
  type NodeId,
  type Tree,
  type TreeNode,
} from "./model";

export type ContainerNode = TreeNode & { kind: "window" | "group" };

export function isContainer(node: TreeNode): node is ContainerNode {
  return node.kind === "window" || node.kind === "group";
}

export interface ContainerSummary {
  /** Saved tab nodes beneath the container that have a url (the ones "Reopen all" opens). */
  savedTabs: number;
  /** Live tab nodes beneath the container (the ones "Close all and save" closes). */
  liveTabs: number;
  /** Direct children, of any kind. */
  children: number;
  isWindow: boolean;
  isLiveWindow: boolean;
}

export function summarizeContainer(
  tree: Tree,
  node: TreeNode,
  index: ChildIndex = buildChildIndex(tree),
): ContainerSummary {
  let savedTabs = 0;
  let liveTabs = 0;
  for (const id of descendantIds(tree, node.id, index)) {
    const n = tree.get(id);
    if (!n || n.kind !== "tab") continue;
    if (n.liveTabId !== undefined) liveTabs++;
    else if (n.url) savedTabs++;
  }
  return {
    savedTabs,
    liveTabs,
    children: index.get(node.id)?.length ?? 0,
    isWindow: node.kind === "window",
    isLiveWindow: node.kind === "window" && node.liveWindowId !== undefined,
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
  const id = node.id;
  const reopenLabel = s.isWindow && !s.isLiveWindow ? "Reopen window" : "Reopen all";
  const closeLabel = s.isLiveWindow ? "Close window and save" : "Close all and save";
  return [
    {
      id: "reopen",
      label: s.savedTabs ? `${reopenLabel} (${plural(s.savedTabs, "saved tab")})` : reopenLabel,
      icon: "restore",
      section: "open",
      shortcut: s.isLiveWindow ? undefined : "Enter",
      disabled: s.savedTabs === 0,
      inRow: true,
      run: () => handlers.reopenAll(id),
    },
    {
      id: "closeAndSave",
      label: s.liveTabs ? `${closeLabel} (${plural(s.liveTabs, "open tab")})` : closeLabel,
      icon: "close",
      section: "open",
      shortcut: "Del",
      disabled: s.liveTabs === 0,
      inRow: true,
      run: () => handlers.closeAndSave(id),
    },
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
    {
      id: "delete",
      label: s.liveTabs ? `Delete (closes ${plural(s.liveTabs, "open tab")})` : "Delete",
      icon: "trash",
      section: "danger",
      danger: true,
      disabled: false,
      inRow: true,
      run: () => handlers.deleteNode(id),
    },
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

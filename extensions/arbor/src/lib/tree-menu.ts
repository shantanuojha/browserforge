/**
 * The context menu of a tree row, as data. Containers render from the shared
 * `containerActions` definition; tabs and notes have their own short lists. Pure: no DOM.
 */
import type { ContainerAction } from "./container-actions";
import { isBound, type ChildIndex, type NodeId, type Tree, type TreeNode } from "./model";
import {
  canCloseAndRemove,
  canRemove,
  closeAndRemoveLabel,
  removeLabel,
  summarizeRemoval,
} from "./removal";

export interface MenuItem {
  label: string;
  shortcut?: string | undefined;
  danger?: boolean | undefined;
  disabled?: boolean | undefined;
  onSelect: () => void;
}

export type MenuEntry = MenuItem | "separator";

/** What the menu can ask the panel to do. */
export interface MenuHandlers {
  primary(id: NodeId): void;
  closeAndSave(id: NodeId): void;
  restore(id: NodeId): void;
  removeNode(id: NodeId): void;
  closeAndRemove(id: NodeId): void;
  toggleCollapse(id: NodeId, collapsed: boolean): void;
  editNote(id: NodeId): void;
  startRename(id: NodeId): void;
  addGroup(parentId: NodeId | null, index: number): void;
  addNote(parentId: NodeId, index: number): void;
}

export interface MenuContext {
  tree: Tree;
  node: TreeNode;
  childIndex: ChildIndex;
  /** The shared container definition, `null` for tab and note rows. */
  containerActions: ContainerAction[] | null;
  handlers: MenuHandlers;
}

const asItem = (a: ContainerAction): MenuItem => ({
  label: a.label,
  shortcut: a.shortcut,
  danger: a.danger,
  disabled: a.disabled,
  onSelect: a.run,
});

/** "New group inside", "New note inside", "New group after". */
function newItems({ node, childIndex, handlers }: MenuContext): MenuItem[] {
  const siblings = childIndex.get(node.parentId) ?? [];
  const myIndex = siblings.findIndex((s) => s.id === node.id);
  return [
    { label: "New group inside", onSelect: () => handlers.addGroup(node.id, 0) },
    { label: "New note inside", onSelect: () => handlers.addNote(node.id, 0) },
    { label: "New group after", onSelect: () => handlers.addGroup(node.parentId, myIndex + 1) },
  ];
}

const focusItem = (node: TreeNode, handlers: MenuHandlers): MenuItem => ({
  label: "Focus",
  shortcut: "Enter",
  onSelect: () => handlers.primary(node.id),
});

/**
 * Containers: the shared definition, section by section, plus the "New ..." entries and "Focus"
 * while the container's window is open.
 */
function containerMenu(context: MenuContext, actions: ContainerAction[]): MenuEntry[] {
  const { node, handlers } = context;
  const section = (name: ContainerAction["section"]) =>
    actions.filter((a) => a.section === name).map(asItem);
  const edit = section("edit");
  const items: MenuEntry[] = [];
  if (isBound(node)) items.push(focusItem(node, handlers));
  items.push(...section("open"), "separator");
  items.push(...edit.slice(0, 2), ...newItems(context), ...edit.slice(2), "separator");
  items.push(...section("remove"));
  return items;
}

/** The first section of a tab row: focus / close when open, restore when saved. */
function tabOpenItems(node: TreeNode, handlers: MenuHandlers): MenuItem[] {
  if (node.kind !== "tab") return [];
  if (node.liveTabId !== undefined) {
    return [
      focusItem(node, handlers),
      { label: "Close and save", onSelect: () => handlers.closeAndSave(node.id) },
    ];
  }
  return [
    {
      label: "Restore tab",
      shortcut: "Enter",
      disabled: !node.url,
      onSelect: () => handlers.restore(node.id),
    },
  ];
}

/**
 * The last section of a tab or note row, the same two ways out as on a container: "Remove from
 * tree" (Delete; an open tab stays open and stays in the tree under its window) and the
 * destructive "Close tabs and remove" (Shift+Delete), off when nothing beneath is open.
 */
function leafRemoveItems({ tree, node, childIndex, handlers }: MenuContext): MenuItem[] {
  const s = summarizeRemoval(tree, node, childIndex);
  return [
    {
      label: removeLabel(s, node),
      shortcut: "Del",
      disabled: !canRemove(s),
      onSelect: () => handlers.removeNode(node.id),
    },
    {
      label: closeAndRemoveLabel(s),
      shortcut: "Shift+Del",
      danger: true,
      disabled: !canCloseAndRemove(s),
      onSelect: () => handlers.closeAndRemove(node.id),
    },
  ];
}

function leafMenu(context: MenuContext): MenuEntry[] {
  const { node, childIndex, handlers } = context;
  const fresh = newItems(context);
  const items: MenuEntry[] = [...tabOpenItems(node, handlers), "separator"];
  items.push({
    label: node.note ? "Edit note" : "Add note",
    shortcut: "N",
    onSelect: () => handlers.editNote(node.id),
  });
  if (node.kind === "note") {
    items.push(
      { label: "Rename", shortcut: "F2", onSelect: () => handlers.startRename(node.id) },
      fresh[2] as MenuItem,
    );
  } else {
    items.push(...fresh);
  }
  if (childIndex.get(node.id)?.length) {
    items.push({
      label: node.collapsed ? "Expand" : "Collapse",
      shortcut: "Space",
      onSelect: () => handlers.toggleCollapse(node.id, !node.collapsed),
    });
  }
  items.push("separator", ...leafRemoveItems(context));
  return items;
}

export function buildContextMenu(context: MenuContext): MenuEntry[] {
  return context.containerActions
    ? containerMenu(context, context.containerActions)
    : leafMenu(context);
}

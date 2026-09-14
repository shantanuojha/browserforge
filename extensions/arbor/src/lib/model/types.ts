/**
 * Arbor tree model: node, op and snapshot types.
 *
 * The tree is an immutable `ReadonlyMap<NodeId, TreeNode>`. Every mutation goes through an `Op`
 * so the persistence layer can log and replay it deterministically. Sibling order is an integer
 * `order` that is renumbered whenever a node is inserted, moved or removed, which keeps replay
 * simple and independent of floating-point tricks.
 */

export type NodeId = string;

/**
 * Node kinds. There is one container kind, `window`: a node that holds tabs and is either
 * *bound* to an open browser window (`liveWindowId` set) or *unbound* (closed). What the UI calls
 * a "group" is simply an unbound container the user created and titled; a window the browser
 * opened is a bound container with an empty title (shown as "Window"). Reopening an unbound
 * container opens it as a browser window; closing a bound container's window leaves it unbound.
 * Trees written before 0.1.4 used a separate `group` kind; `coerceNode` reads it as `window`.
 */
export type NodeKind = "window" | "tab" | "note";

/** Kind that older trees, exports and op logs used for user groups; read as `window`. */
export const LEGACY_GROUP_KIND = "group";

/** Title shown for a container the user has not named (a window the browser opened). */
export const DEFAULT_WINDOW_TITLE = "Window";

export interface TreeNode {
  id: NodeId;
  parentId: NodeId | null;
  kind: NodeKind;
  /** User-visible name. Empty on containers the browser created; see `displayTitle`. */
  title: string;
  url?: string | undefined;
  favIconUrl?: string | undefined;
  note?: string | undefined;
  collapsed?: boolean | undefined;
  /** Set while the node mirrors an open browser tab. */
  liveTabId?: number | undefined;
  /** Set while the node mirrors an open browser window (or the window a live tab belongs to). */
  liveWindowId?: number | undefined;
  createdAt: number;
  updatedAt: number;
  order: number;
}

/**
 * Fields a caller may change on an existing node. `undefined` or `null` removes the field. Use
 * `null` for patches that travel over `runtime.sendMessage`: messaging has JSON semantics and
 * silently drops `undefined` properties, which would turn "clear this field" into a no-op.
 */
export type NodePatch = {
  [K in keyof Omit<TreeNode, "id" | "createdAt" | "order" | "parentId">]?:
    TreeNode[K] | null | undefined;
};

export type OpBody =
  | { type: "add"; node: TreeNode; index?: number | undefined }
  | { type: "update"; id: NodeId; patch: NodePatch }
  | { type: "move"; id: NodeId; parentId: NodeId | null; index: number }
  | { type: "remove"; id: NodeId };

export type OpType = OpBody["type"];

/** The op of one kind, for handler tables keyed by `type`. */
export type OpOf<T extends OpType> = Extract<OpBody, { type: T }>;

export type Op = OpBody & { seq: number; ts: number };

export interface Snapshot {
  seq: number;
  ts: number;
  nodes: TreeNode[];
  nodeCount: number;
}

export type Tree = ReadonlyMap<NodeId, TreeNode>;

export class OpError extends Error {
  constructor(
    message: string,
    readonly op?: OpBody,
  ) {
    super(message);
    this.name = "OpError";
  }
}

/**
 * Turning untrusted JSON (snapshots, the op log, backups, exports) back into nodes and ops.
 * Anything malformed yields `undefined`; callers decide whether that is a skipped record or a
 * quarantined one.
 */
import {
  LEGACY_GROUP_KIND,
  type NodeId,
  type NodeKind,
  type NodePatch,
  type Op,
  type OpOf,
  type OpType,
  type TreeNode,
} from "./types";

type Raw = Record<string, unknown>;

function asRecord(value: unknown): Raw | undefined {
  return typeof value === "object" && value !== null ? (value as Raw) : undefined;
}

function isParentId(value: unknown): value is NodeId | null {
  return value === null || typeof value === "string";
}

/** The pre-0.1.4 `group` kind is an unbound container: read it as `window`. */
function kindOf(value: unknown): NodeKind | undefined {
  const kind = value === LEGACY_GROUP_KIND ? "window" : value;
  return kind === "window" || kind === "tab" || kind === "note" ? kind : undefined;
}

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === "number" ? value : fallback;

/** Optional string fields, copied only when present and of the right type. */
const STRING_FIELDS = ["url", "favIconUrl", "note"] as const;
const NUMBER_FIELDS = ["liveTabId", "liveWindowId"] as const;

function optionalFields(v: Raw, node: TreeNode): void {
  for (const field of STRING_FIELDS) {
    const value = v[field];
    if (typeof value === "string") node[field] = value;
  }
  for (const field of NUMBER_FIELDS) {
    const value = v[field];
    if (typeof value === "number") node[field] = value;
  }
  if (v.collapsed === true) node.collapsed = true;
}

/**
 * Ensure a value parsed from JSON is a TreeNode; returns undefined otherwise. The pre-0.1.4
 * `group` kind is read as `window` (an unbound container), so old snapshots, op logs, backups
 * and exports load unchanged. `now` stands in for missing timestamps.
 */
export function coerceNode(value: unknown, now: number): TreeNode | undefined {
  const v = asRecord(value);
  if (!v) return undefined;
  if (typeof v.id !== "string" || !v.id) return undefined;
  if (!isParentId(v.parentId)) return undefined;
  const kind = kindOf(v.kind);
  if (!kind) return undefined;
  const node: TreeNode = {
    id: v.id,
    parentId: v.parentId,
    kind,
    title: typeof v.title === "string" ? v.title : "",
    createdAt: numberOr(v.createdAt, now),
    updatedAt: numberOr(v.updatedAt, now),
    order: numberOr(v.order, 0),
  };
  optionalFields(v, node);
  return node;
}

type BodyCoercer<T extends OpType> = (v: Raw, now: number) => OpOf<T> | undefined;

const BODY_COERCERS: { [T in OpType]: BodyCoercer<T> } = {
  add(v, now) {
    const node = coerceNode(v.node, now);
    if (!node) return undefined;
    return typeof v.index === "number"
      ? { type: "add", node, index: v.index }
      : { type: "add", node };
  },
  update(v) {
    if (typeof v.id !== "string") return undefined;
    const patch = asRecord(v.patch);
    return patch ? { type: "update", id: v.id, patch: patch as NodePatch } : undefined;
  },
  move(v) {
    if (typeof v.id !== "string" || !isParentId(v.parentId) || typeof v.index !== "number") {
      return undefined;
    }
    return { type: "move", id: v.id, parentId: v.parentId, index: v.index };
  },
  remove(v) {
    return typeof v.id === "string" ? { type: "remove", id: v.id } : undefined;
  },
};

function isOpType(value: unknown): value is OpType {
  return typeof value === "string" && Object.hasOwn(BODY_COERCERS, value);
}

/** Ensure a value parsed from storage is an Op; returns undefined otherwise. */
export function coerceOp(value: unknown, now: number): Op | undefined {
  const v = asRecord(value);
  if (!v) return undefined;
  if (typeof v.seq !== "number" || typeof v.ts !== "number" || !isOpType(v.type)) return undefined;
  const body = (BODY_COERCERS[v.type] as BodyCoercer<OpType>)(v, now);
  return body ? { seq: v.seq, ts: v.ts, ...body } : undefined;
}

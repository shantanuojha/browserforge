/**
 * Ops built in the side panel travel through `runtime.sendMessage`, which has JSON semantics:
 * properties whose value is `undefined` are dropped. A "clear this field" patch therefore has to
 * use `null`, or it arrives as `{}` and the node never changes (regression: a collapsed window
 * could not be expanded again, hiding every tab beneath it).
 */
import { describe, expect, it } from "vitest";
import { defineMessage, MessageRouter } from "./messaging";
import { applyOp, applyOps, createTree, makeNode, ops, type OpBody } from "./model";

/** What `runtime.sendMessage` does to a payload. */
const overTheWire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function fixture() {
  return applyOps(createTree(), [
    ops.add(makeNode({ id: "w", parentId: null, kind: "window", title: "Window", ts: 1 })),
    ops.add(makeNode({ id: "t", parentId: "w", kind: "tab", title: "Tab", ts: 1 })),
  ]);
}

describe("ops survive runtime messaging", () => {
  it("demonstrates the hazard: undefined patch values vanish in transit", () => {
    expect(overTheWire({ collapsed: undefined })).toEqual({});
    expect(overTheWire({ collapsed: null })).toEqual({ collapsed: null });
  });

  it("expanding a collapsed node still works after the op crossed the wire", () => {
    let tree = applyOp(fixture(), overTheWire(ops.collapse("w", true)));
    expect(tree.get("w")?.collapsed).toBe(true);
    tree = applyOp(tree, overTheWire(ops.collapse("w", false)));
    expect(tree.get("w")?.collapsed).toBeUndefined();
    expect("collapsed" in (tree.get("w") ?? {})).toBe(false);
  });

  it("clearing a note still works after the op crossed the wire", () => {
    let tree = applyOp(fixture(), overTheWire(ops.note("t", "  remember this ")));
    expect(tree.get("t")?.note).toBe("remember this");
    tree = applyOp(tree, overTheWire(ops.note("t", "   ")));
    expect(tree.get("t")?.note).toBeUndefined();
  });

  it("null and undefined both remove a field when applied locally", () => {
    const tree = applyOps(fixture(), [
      ops.update("t", { note: "a", liveTabId: 7 }),
      ops.update("t", { note: null, liveTabId: undefined }),
    ]);
    expect(tree.get("t")?.note).toBeUndefined();
    expect(tree.get("t")?.liveTabId).toBeUndefined();
  });
});

describe("MessageRouter", () => {
  const applyOpsMsg = defineMessage<OpBody[], number>("applyOps");

  it("dispatches envelopes to the matching handler with the payload as sent", async () => {
    const router = new MessageRouter();
    const seen: OpBody[][] = [];
    router.on(applyOpsMsg, (bodies) => {
      seen.push(bodies);
      return bodies.length;
    });
    const envelope = overTheWire({ __arbor: "applyOps", payload: [ops.collapse("w", false)] });
    const wire = await router.dispatch(envelope, {});
    expect(wire).toEqual({ ok: true, value: 1 });
    expect(seen[0]?.[0]).toEqual({ type: "update", id: "w", patch: { collapsed: null } });
  });

  it("reports handler errors instead of dropping the response", async () => {
    const router = new MessageRouter();
    router.on(applyOpsMsg, () => {
      throw new Error("nope");
    });
    const wire = await router.dispatch({ __arbor: "applyOps", payload: [] }, {});
    expect(wire).toEqual({ ok: false, error: "nope" });
    expect(await router.dispatch({ unrelated: true }, {})).toBeUndefined();
  });
});

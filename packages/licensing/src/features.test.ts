import { describe, expect, it } from "vitest";
import { createLicenseClient } from "./client";
import { defineFeatures } from "./features";
import { RAW_KEY, activatedBody, createFakeFetch, createMemoryStorage } from "./test-utils";

function proClient() {
  const { fetch } = createFakeFetch((endpoint) =>
    endpoint === "deactivate" ? { json: { deactivated: true } } : { json: activatedBody() },
  );
  return createLicenseClient({ productName: "arbor", storage: createMemoryStorage(), fetch });
}

describe("defineFeatures()", () => {
  const features = defineFeatures({ backups: "pro", drive: "pro", tree: "free" });

  it("only allows free features before init()", () => {
    const gate = defineFeatures({ backups: "pro", tree: "free" });
    expect(gate.isReady()).toBe(false);
    expect(gate.can("tree")).toBe(true);
    expect(gate.can("backups")).toBe(false);
    expect(gate.tierOf("backups")).toBe("pro");
  });

  it("answers synchronously from the cached state after init()", async () => {
    const client = proClient();
    const gate = defineFeatures({ backups: "pro", tree: "free" });
    await gate.init(client);
    expect(gate.isReady()).toBe(true);
    expect(gate.getState()).toEqual({ kind: "free" });
    expect(gate.can("backups")).toBe(false);

    await client.activate(RAW_KEY);
    expect(gate.can("backups")).toBe(true);
    expect(gate.can("tree")).toBe(true);

    await client.deactivate();
    expect(gate.can("backups")).toBe(false);
    gate.dispose();
  });

  it("stops following changes after dispose()", async () => {
    const client = proClient();
    const gate = defineFeatures({ backups: "pro" });
    await gate.init(client);
    gate.dispose();
    await client.activate(RAW_KEY);
    expect(gate.can("backups")).toBe(false);
  });

  it("is typed to the declared feature names", () => {
    // @ts-expect-error unknown feature
    features.can("nope");
    expect(features.features.drive).toBe("pro");
  });
});

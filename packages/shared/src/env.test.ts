import { describe, expect, it } from "vitest";
import { readEnum, readHttpsUrl, readPositiveInteger, readSlug, readUuid } from "./env.js";

describe("readPositiveInteger", () => {
  it("accepts positive integers as strings or numbers", () => {
    expect(readPositiveInteger("7")).toBe(7);
    expect(readPositiveInteger(" 42 ")).toBe(42);
    expect(readPositiveInteger(9)).toBe(9);
  });

  it("treats anything else as unset", () => {
    expect(readPositiveInteger("")).toBeUndefined();
    expect(readPositiveInteger("abc")).toBeUndefined();
    expect(readPositiveInteger("0")).toBeUndefined();
    expect(readPositiveInteger("-1")).toBeUndefined();
    expect(readPositiveInteger("1.5")).toBeUndefined();
    expect(readPositiveInteger(undefined)).toBeUndefined();
    expect(readPositiveInteger(null)).toBeUndefined();
  });
});

describe("readHttpsUrl", () => {
  it("accepts https URLs only", () => {
    expect(readHttpsUrl("https://store.example/checkout")).toBe("https://store.example/checkout");
    expect(readHttpsUrl("http://insecure.example")).toBeUndefined();
    expect(readHttpsUrl("not a url")).toBeUndefined();
    expect(readHttpsUrl("")).toBeUndefined();
    expect(readHttpsUrl(42)).toBeUndefined();
  });
});

describe("readUuid", () => {
  it("accepts a UUID in any case and returns it lower-cased", () => {
    expect(readUuid(" 8F0F7F5E-2A4C-4F3E-9A51-3F0F1A6B2C7D ")).toBe(
      "8f0f7f5e-2a4c-4f3e-9a51-3f0f1a6b2c7d",
    );
  });

  it("treats anything else as unset", () => {
    expect(readUuid("")).toBeUndefined();
    expect(readUuid("8f0f7f5e2a4c4f3e9a513f0f1a6b2c7d")).toBeUndefined();
    expect(readUuid("8f0f7f5e-2a4c-4f3e-9a51-3f0f1a6b2c7")).toBeUndefined();
    expect(readUuid("not-a-uuid")).toBeUndefined();
    expect(readUuid(42)).toBeUndefined();
  });
});

describe("readSlug", () => {
  it("accepts URL-safe path segments", () => {
    expect(readSlug("browserforge")).toBe("browserforge");
    expect(readSlug(" my-org_1 ")).toBe("my-org_1");
  });

  it("treats anything else as unset", () => {
    expect(readSlug("")).toBeUndefined();
    expect(readSlug("-leading")).toBeUndefined();
    expect(readSlug("has space")).toBeUndefined();
    expect(readSlug("a/b")).toBeUndefined();
    expect(readSlug(null)).toBeUndefined();
  });
});

describe("readEnum", () => {
  const providers = ["lemonsqueezy", "polar"] as const;

  it("matches one of the allowed values, ignoring case and whitespace", () => {
    expect(readEnum(" Polar ", providers)).toBe("polar");
    expect(readEnum("lemonsqueezy", providers)).toBe("lemonsqueezy");
  });

  it("treats anything else as unset", () => {
    expect(readEnum("stripe", providers)).toBeUndefined();
    expect(readEnum("", providers)).toBeUndefined();
    expect(readEnum(undefined, providers)).toBeUndefined();
  });
});

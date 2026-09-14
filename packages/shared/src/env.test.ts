import { describe, expect, it } from "vitest";
import { readHttpsUrl, readPositiveInteger } from "./env.js";

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

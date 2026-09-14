import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  base64ToUtf8,
  bytesToBase64,
  toBase64Url,
  utf8ToBase64,
  utf8ToBase64Url,
} from "./base64.js";

describe("base64", () => {
  it("round-trips UTF-8 text", () => {
    const text = "w\u00f6rld \u2014 \u{1F600}";
    expect(base64ToUtf8(utf8ToBase64(text))).toBe(text);
  });

  it("round-trips raw bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
  });

  it("decodes the URL-safe alphabet, whitespace and missing padding", () => {
    const standard = utf8ToBase64("any carnal pleas");
    expect(standard).toBe("YW55IGNhcm5hbCBwbGVhcw==");
    expect(base64ToUtf8("YW55IGNhcm5hbCBwbGVhcw")).toBe("any carnal pleas");
    expect(base64ToUtf8("YW55 IGNh\ncm5hbCBw bGVhcw==")).toBe("any carnal pleas");
    expect(base64ToUtf8(toBase64Url(utf8ToBase64("\u00ff\u00fe?")))).toBe("\u00ff\u00fe?");
  });

  it("produces URL-safe output without padding", () => {
    const url = utf8ToBase64Url("\u00ff\u00fe??>>");
    expect(url).not.toMatch(/[+/=]/);
    expect(base64ToUtf8(url)).toBe("\u00ff\u00fe??>>");
  });
});

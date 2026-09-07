import { describe, expect, it } from "vitest";
import { browserFamily, randomInstanceSuffix } from "./instance";
import { looksLikeLicenseKey, maskKey, normalizeKey } from "./mask";

describe("maskKey()", () => {
  it("reveals only the last four characters", () => {
    expect(maskKey("38b1460a-5104-4067-a91d-77b872934d51")).toBe("XXXX-…-4d51");
    expect(maskKey("  ABCDEFGH1234  ")).toBe("XXXX-…-1234");
  });

  it("handles short and empty input", () => {
    expect(maskKey("")).toBe("");
    expect(maskKey("ab")).toBe("XXXX-…-XX");
    expect(maskKey("abcd")).toBe("XXXX-…-XXXX");
  });
});

describe("normalizeKey() / looksLikeLicenseKey()", () => {
  it("strips whitespace and line breaks from pasted keys", () => {
    expect(normalizeKey(" 38b1-\n4067 ")).toBe("38b1-4067");
  });

  it("rejects obviously bad input", () => {
    expect(looksLikeLicenseKey("")).toBe(false);
    expect(looksLikeLicenseKey("abc")).toBe(false);
    expect(looksLikeLicenseKey("has spaces inside here")).toBe(true);
    expect(looksLikeLicenseKey("bad$chars-000000")).toBe(false);
    expect(looksLikeLicenseKey("38b1460a-5104-4067-a91d-77b872934d51")).toBe(true);
  });
});

describe("instance naming", () => {
  it("derives a coarse browser family", () => {
    expect(browserFamily("Mozilla/5.0 Chrome/128.0 Safari/537.36 Edg/128.0")).toBe("edge");
    expect(browserFamily("Mozilla/5.0 Chrome/128.0 Safari/537.36 OPR/110")).toBe("opera");
    expect(browserFamily("Mozilla/5.0 Gecko/20100101 Firefox/130.0")).toBe("firefox");
    expect(browserFamily("Mozilla/5.0 Chrome/128.0 Safari/537.36")).toBe("chrome");
    expect(browserFamily("Mozilla/5.0 Version/17 Safari/605.1")).toBe("safari");
    expect(browserFamily(undefined)).toBe("browser");
  });

  it("generates 6-char base36 suffixes", () => {
    const a = randomInstanceSuffix();
    expect(a).toMatch(/^[a-z0-9]{6}$/);
    expect(randomInstanceSuffix()).not.toBe(a);
  });
});

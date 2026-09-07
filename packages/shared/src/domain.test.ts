import { describe, expect, it } from "vitest";
import { hostMatchesAny, hostMatchesPattern, normalizeHost, siteOf } from "./domain.js";

describe("normalizeHost", () => {
  it("strips scheme, case and stray dots", () => {
    expect(normalizeHost("HTTPS://Example.COM/path")).toBe("example.com");
    expect(normalizeHost(".example.com.")).toBe("example.com");
    expect(normalizeHost("  sub.Example.com ")).toBe("sub.example.com");
  });
});

describe("hostMatchesPattern", () => {
  it("matches exact hosts", () => {
    expect(hostMatchesPattern("example.com", "example.com")).toBe(true);
    expect(hostMatchesPattern("www.example.com", "example.com")).toBe(false);
  });
  it("matches *.host as subdomains only", () => {
    expect(hostMatchesPattern("a.example.com", "*.example.com")).toBe(true);
    expect(hostMatchesPattern("example.com", "*.example.com")).toBe(false);
    expect(hostMatchesPattern("notexample.com", "*.example.com")).toBe(false);
  });
  it("matches *host as apex or subdomain", () => {
    expect(hostMatchesPattern("example.com", "*example.com")).toBe(true);
    expect(hostMatchesPattern("a.b.example.com", "*example.com")).toBe(true);
    expect(hostMatchesPattern("notexample.com", "*example.com")).toBe(false);
  });
  it("rejects empty input", () => {
    expect(hostMatchesPattern("", "example.com")).toBe(false);
    expect(hostMatchesAny("example.com", [])).toBe(false);
  });
});

describe("siteOf", () => {
  it("collapses to two labels by default", () => {
    expect(siteOf("a.b.example.com")).toBe("example.com");
    expect(siteOf("example.com")).toBe("example.com");
    expect(siteOf("localhost")).toBe("localhost");
  });
  it("keeps three labels for common ccSLDs", () => {
    expect(siteOf("news.bbc.co.uk")).toBe("bbc.co.uk");
    expect(siteOf("shop.example.com.au")).toBe("example.com.au");
  });
});

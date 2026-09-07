import { describe, expect, it } from "vitest";
import {
  classifyHost,
  domainsForSite,
  hostFromTabUrl,
  isIpHost,
  listTypeFor,
  normalizeCookieDomain,
  planCleanup,
  planStore,
  sameSite,
  siteKey,
  suggestedPattern,
  summarizePlan,
  type PlannerInput,
} from "./planner.js";
import type { ListEntry } from "./settings.js";

const white = (pattern: string, storeId?: string): ListEntry =>
  storeId ? { pattern, listType: "white", storeId } : { pattern, listType: "white" };
const grey = (pattern: string, storeId?: string): ListEntry =>
  storeId ? { pattern, listType: "grey", storeId } : { pattern, listType: "grey" };

function input(overrides: Partial<PlannerInput>): PlannerInput {
  return {
    openTabHosts: {},
    cookieDomains: {},
    lists: [],
    greyExpiredAtRestart: false,
    trigger: "tab-close",
    ...overrides,
  };
}

describe("hostFromTabUrl", () => {
  it("extracts hostnames from http(s) URLs", () => {
    expect(hostFromTabUrl("https://www.Example.com/path?q=1")).toBe("www.example.com");
    expect(hostFromTabUrl("http://example.com:8080/")).toBe("example.com");
    expect(hostFromTabUrl("http://192.168.1.10:3000/app")).toBe("192.168.1.10");
    expect(hostFromTabUrl("http://[::1]:8080/")).toBe("[::1]");
    expect(hostFromTabUrl("http://localhost:5173/")).toBe("localhost");
  });
  it("ignores tabs that cannot own web cookies", () => {
    expect(hostFromTabUrl("file:///C:/Users/me/index.html")).toBeNull();
    expect(hostFromTabUrl("chrome://newtab/")).toBeNull();
    expect(hostFromTabUrl("chrome://settings/cookies")).toBeNull();
    expect(hostFromTabUrl("chrome-extension://abcdef/options.html")).toBeNull();
    expect(hostFromTabUrl("moz-extension://1234/popup.html")).toBeNull();
    expect(hostFromTabUrl("about:blank")).toBeNull();
    expect(hostFromTabUrl("about:newtab")).toBeNull();
    expect(hostFromTabUrl("edge://settings")).toBeNull();
    expect(hostFromTabUrl("data:text/html,hi")).toBeNull();
    expect(hostFromTabUrl("ftp://files.example.com/")).toBeNull();
    expect(hostFromTabUrl("view-source:https://example.com")).toBeNull();
  });
  it("accepts bare hosts with optional ports", () => {
    expect(hostFromTabUrl("Example.com")).toBe("example.com");
    expect(hostFromTabUrl("localhost:3000")).toBe("localhost");
    expect(hostFromTabUrl("[::1]:8080")).toBe("[::1]");
    expect(hostFromTabUrl(".example.com.")).toBe("example.com");
  });
  it("rejects empty and malformed input", () => {
    expect(hostFromTabUrl("")).toBeNull();
    expect(hostFromTabUrl("   ")).toBeNull();
    expect(hostFromTabUrl(undefined)).toBeNull();
    expect(hostFromTabUrl(null)).toBeNull();
    expect(hostFromTabUrl("http://")).toBeNull();
    expect(hostFromTabUrl("not a host")).toBeNull();
  });
});

describe("normalizeCookieDomain", () => {
  it("strips leading dots and lowercases", () => {
    expect(normalizeCookieDomain(".example.com")).toBe("example.com");
    expect(normalizeCookieDomain("..Example.COM")).toBe("example.com");
    expect(normalizeCookieDomain("www.example.com")).toBe("www.example.com");
  });
});

describe("isIpHost / siteKey / sameSite", () => {
  it("detects IP literals", () => {
    expect(isIpHost("127.0.0.1")).toBe(true);
    expect(isIpHost("192.168.0.1")).toBe(true);
    expect(isIpHost("[::1]")).toBe(true);
    expect(isIpHost("example.com")).toBe(false);
    expect(isIpHost("localhost")).toBe(false);
  });
  it("collapses hostnames to their site", () => {
    expect(siteKey("mail.google.com")).toBe("google.com");
    expect(siteKey(".google.com")).toBe("google.com");
    expect(siteKey("news.bbc.co.uk")).toBe("bbc.co.uk");
    expect(siteKey("bbc.co.uk")).toBe("bbc.co.uk");
  });
  it("keeps IPs and single-label hosts as-is", () => {
    expect(siteKey("192.168.1.1")).toBe("192.168.1.1");
    expect(siteKey("[::1]")).toBe("[::1]");
    expect(siteKey("localhost")).toBe("localhost");
  });
  it("compares sites, not hosts", () => {
    expect(sameSite("accounts.google.com", "mail.google.com")).toBe(true);
    expect(sameSite(".google.com", "mail.google.com")).toBe(true);
    expect(sameSite("news.bbc.co.uk", "bbc.co.uk")).toBe(true);
    expect(sameSite("example.co.uk", "other.co.uk")).toBe(false);
    expect(sameSite("192.168.1.1", "192.168.1.2")).toBe(false);
    expect(sameSite("192.168.1.1", "192.168.1.1")).toBe(true);
    expect(sameSite("localhost", "app.localhost")).toBe(false);
    expect(sameSite("", "")).toBe(false);
  });
});

describe("listTypeFor", () => {
  it("matches exact patterns against the cookie domain only", () => {
    const lists = [white("example.com")];
    expect(listTypeFor("example.com", "0", lists)).toBe("white");
    expect(listTypeFor(".example.com", "0", lists)).toBe("white");
    expect(listTypeFor("www.example.com", "0", lists)).toBeNull();
  });
  it("supports *.host (subdomains only) and *host (apex + subdomains)", () => {
    expect(listTypeFor("a.example.com", "0", [white("*.example.com")])).toBe("white");
    expect(listTypeFor("example.com", "0", [white("*.example.com")])).toBeNull();
    expect(listTypeFor("example.com", "0", [white("*example.com")])).toBe("white");
    expect(listTypeFor("deep.a.example.com", "0", [white("*example.com")])).toBe("white");
    expect(listTypeFor("notexample.com", "0", [white("*example.com")])).toBeNull();
  });
  it("whitelist wins over greylist when both match", () => {
    const lists = [grey("*example.com"), white("login.example.com")];
    expect(listTypeFor("login.example.com", "0", lists)).toBe("white");
    expect(listTypeFor("shop.example.com", "0", lists)).toBe("grey");
  });
  it("honours per-store entries", () => {
    const lists = [white("example.com", "firefox-container-1")];
    expect(listTypeFor("example.com", "firefox-container-1", lists)).toBe("white");
    expect(listTypeFor("example.com", "firefox-default", lists)).toBeNull();
    expect(listTypeFor("example.com", "0", [white("example.com")])).toBe("white");
  });
});

describe("classifyHost / suggestedPattern", () => {
  it("treats the host or its site as listed", () => {
    expect(classifyHost("www.example.com", "0", [white("example.com")])).toBe("white");
    expect(classifyHost("www.example.com", "0", [grey("*example.com")])).toBe("grey");
    expect(classifyHost("www.example.com", "0", [white("*.other.com")])).toBeNull();
    expect(classifyHost("", "0", [white("example.com")])).toBeNull();
    expect(classifyHost("news.bbc.co.uk", "0", [white("bbc.co.uk")])).toBe("white");
  });
  it("suggests an apex wildcard for normal sites and exact hosts otherwise", () => {
    expect(suggestedPattern("www.example.com")).toBe("*example.com");
    expect(suggestedPattern("news.bbc.co.uk")).toBe("*bbc.co.uk");
    expect(suggestedPattern("127.0.0.1")).toBe("127.0.0.1");
    expect(suggestedPattern("localhost")).toBe("localhost");
  });
});

describe("domainsForSite", () => {
  it("returns the normalised cookie domains belonging to a site", () => {
    const domains = [
      ".example.com",
      "www.example.com",
      "api.example.com",
      "other.com",
      ".Other.com",
    ];
    expect(domainsForSite(domains, "shop.example.com")).toEqual([
      "api.example.com",
      "example.com",
      "www.example.com",
    ]);
    expect(domainsForSite(domains, "other.com")).toEqual(["other.com"]);
    expect(domainsForSite(domains, "nothing.net")).toEqual([]);
  });
});

describe("planStore: open tabs", () => {
  it("never cleans a domain that has an open tab in the same store", () => {
    const plan = planStore(
      "0",
      ["https://mail.google.com/inbox"],
      [".google.com", "accounts.google.com", "mail.google.com", "tracker.net"],
      [],
      { greyExpiredAtRestart: false, trigger: "tab-close" },
    );
    expect(plan.keepDomains).toEqual(["accounts.google.com", "google.com", "mail.google.com"]);
    expect(plan.cleanDomains).toEqual(["tracker.net"]);
    expect(plan.reasons["google.com"]).toBe("open-tab");
    expect(plan.reasons["tracker.net"]).toBe("unlisted");
  });
  it("protects a parent domain when a subdomain tab is open and vice versa", () => {
    const sub = planStore("0", ["https://news.bbc.co.uk/"], ["bbc.co.uk", ".bbc.co.uk"], [], {
      greyExpiredAtRestart: false,
      trigger: "tab-close",
    });
    expect(sub.keepDomains).toEqual(["bbc.co.uk"]);
    const apex = planStore(
      "0",
      ["https://bbc.co.uk/"],
      ["news.bbc.co.uk", "static.bbc.co.uk"],
      [],
      {
        greyExpiredAtRestart: false,
        trigger: "tab-close",
      },
    );
    expect(apex.keepDomains).toEqual(["news.bbc.co.uk", "static.bbc.co.uk"]);
  });
  it("does not let a ccSLD tab protect unrelated sites under the same public suffix", () => {
    const plan = planStore("0", ["https://news.bbc.co.uk/"], ["example.co.uk", "co.uk"], [], {
      greyExpiredAtRestart: false,
      trigger: "tab-close",
    });
    expect(plan.cleanDomains).toEqual(["co.uk", "example.co.uk"]);
  });
  it("treats IP hosts exactly", () => {
    const plan = planStore(
      "0",
      ["http://192.168.1.10:3000/"],
      ["192.168.1.10", "192.168.1.11", "10.0.0.1"],
      [],
      { greyExpiredAtRestart: false, trigger: "tab-close" },
    );
    expect(plan.keepDomains).toEqual(["192.168.1.10"]);
    expect(plan.cleanDomains).toEqual(["10.0.0.1", "192.168.1.11"]);
  });
  it("treats localhost exactly", () => {
    const plan = planStore("0", ["http://localhost:5173/"], ["localhost", "app.localhost"], [], {
      greyExpiredAtRestart: false,
      trigger: "tab-close",
    });
    expect(plan.keepDomains).toEqual(["localhost"]);
    expect(plan.cleanDomains).toEqual(["app.localhost"]);
  });
  it("ignores file://, chrome://, about: and extension tabs", () => {
    const plan = planStore(
      "0",
      [
        "file:///C:/Users/me/example.com.html",
        "chrome://settings/",
        "about:blank",
        "chrome-extension://abc/options.html",
      ],
      ["example.com", "settings"],
      [],
      { greyExpiredAtRestart: false, trigger: "tab-close" },
    );
    expect(plan.cleanDomains).toEqual(["example.com", "settings"]);
    expect(plan.keepDomains).toEqual([]);
  });
  it("normalises and de-duplicates leading-dot cookie domains", () => {
    const plan = planStore("0", [], [".example.com", "example.com", ".Example.COM", ""], [], {
      greyExpiredAtRestart: false,
      trigger: "tab-close",
    });
    expect(plan.cleanDomains).toEqual(["example.com"]);
    expect(Object.keys(plan.reasons)).toEqual(["example.com"]);
  });
});

describe("planStore: lists", () => {
  it("always keeps whitelisted domains", () => {
    const plan = planStore(
      "0",
      [],
      ["example.com", ".example.com", "sub.example.com"],
      [white("*example.com")],
      {
        greyExpiredAtRestart: true,
        trigger: "startup",
        startupScope: "full",
      },
    );
    expect(plan.cleanDomains).toEqual([]);
    expect(plan.reasons["example.com"]).toBe("whitelisted");
    expect(plan.reasons["sub.example.com"]).toBe("whitelisted");
  });
  it("exact whitelist patterns do not cover subdomains", () => {
    const plan = planStore("0", [], ["example.com", "www.example.com"], [white("example.com")], {
      greyExpiredAtRestart: false,
      trigger: "tab-close",
    });
    expect(plan.keepDomains).toEqual(["example.com"]);
    expect(plan.cleanDomains).toEqual(["www.example.com"]);
  });
  it("*.example.com covers subdomains but not the apex", () => {
    const plan = planStore("0", [], ["example.com", "www.example.com"], [white("*.example.com")], {
      greyExpiredAtRestart: false,
      trigger: "tab-close",
    });
    expect(plan.keepDomains).toEqual(["www.example.com"]);
    expect(plan.cleanDomains).toEqual(["example.com"]);
  });
  it("keeps greylisted domains while the browser is running", () => {
    const plan = planStore("0", [], ["shop.example.com"], [grey("*example.com")], {
      greyExpiredAtRestart: false,
      trigger: "tab-close",
    });
    expect(plan.keepDomains).toEqual(["shop.example.com"]);
    expect(plan.reasons["shop.example.com"]).toBe("greylisted");
  });
  it("cleans greylisted domains once the grey period expired", () => {
    const plan = planStore("0", [], ["shop.example.com"], [grey("*example.com")], {
      greyExpiredAtRestart: true,
      trigger: "startup",
    });
    expect(plan.cleanDomains).toEqual(["shop.example.com"]);
    expect(plan.reasons["shop.example.com"]).toBe("grey-expired");
  });
  it("open tabs still protect greylisted domains at startup (session restore)", () => {
    const plan = planStore(
      "0",
      ["https://shop.example.com/"],
      ["shop.example.com"],
      [grey("*example.com")],
      {
        greyExpiredAtRestart: true,
        trigger: "startup",
      },
    );
    expect(plan.keepDomains).toEqual(["shop.example.com"]);
    expect(plan.reasons["shop.example.com"]).toBe("open-tab");
  });
  it("whitelist beats greylist even when grey expired", () => {
    const plan = planStore(
      "0",
      [],
      ["login.example.com"],
      [grey("*example.com"), white("login.example.com")],
      {
        greyExpiredAtRestart: true,
        trigger: "startup",
      },
    );
    expect(plan.keepDomains).toEqual(["login.example.com"]);
  });
  it("applies per-store entries only to their store", () => {
    const lists = [white("example.com", "firefox-container-1")];
    const container = planStore("firefox-container-1", [], ["example.com"], lists, {
      greyExpiredAtRestart: false,
      trigger: "tab-close",
    });
    const def = planStore("firefox-default", [], ["example.com"], lists, {
      greyExpiredAtRestart: false,
      trigger: "tab-close",
    });
    expect(container.keepDomains).toEqual(["example.com"]);
    expect(def.cleanDomains).toEqual(["example.com"]);
  });
});

describe("planStore: startup scope", () => {
  const domains = ["unlisted.com", "grey.com", "white.com"];
  const lists = [grey("grey.com"), white("white.com")];

  it("grey-only startup expires the greylist but leaves unlisted domains alone", () => {
    const plan = planStore("0", [], domains, lists, {
      greyExpiredAtRestart: true,
      trigger: "startup",
    });
    expect(plan.cleanDomains).toEqual(["grey.com"]);
    expect(plan.keepDomains).toEqual(["unlisted.com", "white.com"]);
    expect(plan.reasons["unlisted.com"]).toBe("startup-grey-only");
  });
  it("full startup sweeps unlisted and grey domains", () => {
    const plan = planStore("0", [], domains, lists, {
      greyExpiredAtRestart: true,
      trigger: "startup",
      startupScope: "full",
    });
    expect(plan.cleanDomains).toEqual(["grey.com", "unlisted.com"]);
    expect(plan.keepDomains).toEqual(["white.com"]);
  });
  it("startup without grey expiry is a no-op in grey-only scope", () => {
    const plan = planStore("0", [], domains, lists, {
      greyExpiredAtRestart: false,
      trigger: "startup",
    });
    expect(plan.cleanDomains).toEqual([]);
  });
  it("startup scope does not affect other triggers", () => {
    for (const trigger of ["tab-close", "domain-change", "manual"] as const) {
      const plan = planStore("0", [], domains, lists, {
        greyExpiredAtRestart: false,
        trigger,
        startupScope: "grey-only",
      });
      expect(plan.cleanDomains).toEqual(["unlisted.com"]);
      expect(plan.keepDomains).toEqual(["grey.com", "white.com"]);
    }
  });
  it("manual clean with grey expiry cleans everything except whitelist and open tabs", () => {
    const plan = planStore("0", ["https://unlisted.com/"], domains, lists, {
      greyExpiredAtRestart: true,
      trigger: "manual",
    });
    expect(plan.cleanDomains).toEqual(["grey.com"]);
    expect(plan.keepDomains).toEqual(["unlisted.com", "white.com"]);
  });
});

describe("planCleanup (multi-store)", () => {
  it("isolates open tabs per cookie store", () => {
    const plan = planCleanup(
      input({
        openTabHosts: { "0": ["https://example.com/"] },
        cookieDomains: { "0": ["example.com"], "1": ["example.com"] },
      }),
    );
    expect(plan.stores.map((s) => s.storeId)).toEqual(["0", "1"]);
    expect(plan.stores[0]?.keepDomains).toEqual(["example.com"]);
    expect(plan.stores[1]?.cleanDomains).toEqual(["example.com"]);
  });
  it("produces a plan for stores that only appear in openTabHosts", () => {
    const plan = planCleanup(input({ openTabHosts: { "0": ["https://example.com/"] } }));
    expect(plan.stores).toEqual([{ storeId: "0", cleanDomains: [], keepDomains: [], reasons: {} }]);
  });
  it("passes trigger and startup scope through", () => {
    const plan = planCleanup(
      input({
        cookieDomains: { "0": ["a.com", "g.com"] },
        lists: [grey("g.com")],
        greyExpiredAtRestart: true,
        trigger: "startup",
        startupScope: "full",
      }),
    );
    expect(plan.trigger).toBe("startup");
    expect(plan.stores[0]?.cleanDomains).toEqual(["a.com", "g.com"]);
  });
  it("handles empty input", () => {
    const plan = planCleanup(input({}));
    expect(plan.stores).toEqual([]);
    expect(summarizePlan(plan)).toEqual({ cleanDomains: [], keepDomains: [] });
  });
  it("summarises across stores without duplicates", () => {
    const plan = planCleanup(
      input({
        openTabHosts: { "0": ["https://keep.com/"] },
        cookieDomains: { "0": ["keep.com", "drop.com"], "1": ["drop.com", "keep.com"] },
      }),
    );
    expect(summarizePlan(plan)).toEqual({
      cleanDomains: ["drop.com", "keep.com"],
      keepDomains: ["keep.com"],
    });
  });
});

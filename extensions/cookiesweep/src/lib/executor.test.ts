import { describe, expect, it } from "vitest";
import {
  CHROME_SITE_DATA_TYPES,
  FIREFOX_SITE_DATA_TYPES,
  cleanDomainsInStore,
  cookiePlanningDomain,
  cookieUrl,
  countCookiesForHost,
  executePlan,
  listCookies,
  originsForDomain,
  planningDomains,
  type BrowsingDataRemovalOptions,
  type BrowsingDataTypes,
  type CookiesGetAllDetails,
  type CookiesRemoveDetails,
  type ExecutorApi,
  type ExecutorCookie,
} from "./executor.js";
import { planCleanup } from "./planner.js";

type Flavor = "chrome" | "chrome-old" | "firefox";

interface FakeBrowser extends ExecutorApi {
  jar: ExecutorCookie[];
  getAllCalls: CookiesGetAllDetails[];
  removeCalls: CookiesRemoveDetails[];
  browsingDataCalls: { options: BrowsingDataRemovalOptions; types: BrowsingDataTypes }[];
  failRemoveFor: Set<string>;
}

function cookie(
  partial: Partial<ExecutorCookie> & { name: string; domain: string },
): ExecutorCookie {
  return { path: "/", secure: false, storeId: "0", ...partial };
}

function fakeBrowser(jar: ExecutorCookie[], flavor: Flavor = "chrome"): FakeBrowser {
  const fake: FakeBrowser = {
    jar: [...jar],
    getAllCalls: [],
    removeCalls: [],
    browsingDataCalls: [],
    failRemoveFor: new Set(),
    cookies: {
      async getAll(details) {
        fake.getAllCalls.push(details);
        if (details.partitionKey && flavor === "chrome-old") {
          throw new TypeError("Unexpected property: 'partitionKey'.");
        }
        return fake.jar.filter((c) => {
          if (details.storeId && c.storeId !== details.storeId) return false;
          if (details.domain) {
            const d = c.domain.replace(/^\./, "");
            if (d !== details.domain && !d.endsWith(`.${details.domain}`)) return false;
          }
          if (details.partitionKey) {
            // `{}` matches every partition (and unpartitioned cookies too, like Chrome).
            const top = details.partitionKey.topLevelSite;
            return top ? c.partitionKey?.topLevelSite === top : true;
          }
          return c.partitionKey === undefined;
        });
      },
      async remove(details) {
        fake.removeCalls.push(details);
        if (fake.failRemoveFor.has(details.name)) throw new Error("boom");
        const url = new URL(details.url);
        const idx = fake.jar.findIndex(
          (c) =>
            c.name === details.name &&
            c.domain.replace(/^\./, "") === url.hostname &&
            c.storeId === (details.storeId ?? "0") &&
            (c.partitionKey?.topLevelSite ?? "") === (details.partitionKey?.topLevelSite ?? ""),
        );
        if (idx >= 0) fake.jar.splice(idx, 1);
        return details;
      },
    },
    browsingData: {
      async remove(options, types) {
        fake.browsingDataCalls.push({ options, types });
        if (flavor === "firefox") {
          if (options.origins) throw new TypeError("Unexpected property: 'origins'.");
          if (types.cacheStorage) throw new TypeError("Unexpected property: 'cacheStorage'.");
        } else if (options.hostnames) {
          throw new TypeError("Unexpected property: 'hostnames'.");
        }
      },
    },
  };
  return fake;
}

describe("cookie helpers", () => {
  it("builds the removal URL from secure/domain/path", () => {
    expect(cookieUrl(cookie({ name: "a", domain: ".example.com", secure: true, path: "/x" }))).toBe(
      "https://example.com/x",
    );
    expect(cookieUrl(cookie({ name: "a", domain: "www.example.com", path: "/" }))).toBe(
      "http://www.example.com/",
    );
    expect(cookieUrl(cookie({ name: "a", domain: "example.com", path: "" }))).toBe(
      "http://example.com/",
    );
  });
  it("plans partitioned cookies under their top-level site", () => {
    expect(cookiePlanningDomain(cookie({ name: "a", domain: ".widget.com" }))).toBe("widget.com");
    expect(
      cookiePlanningDomain(
        cookie({
          name: "a",
          domain: ".widget.com",
          partitionKey: { topLevelSite: "https://news.example.com" },
        }),
      ),
    ).toBe("news.example.com");
    expect(
      cookiePlanningDomain(
        cookie({ name: "a", domain: ".widget.com", partitionKey: { topLevelSite: "garbage" } }),
      ),
    ).toBe("widget.com");
  });
  it("derives origins with a www variant for apex domains only", () => {
    expect(originsForDomain(".example.com")).toEqual([
      "https://example.com",
      "http://example.com",
      "https://www.example.com",
      "http://www.example.com",
    ]);
    expect(originsForDomain("api.example.com")).toEqual([
      "https://api.example.com",
      "http://api.example.com",
    ]);
    expect(originsForDomain("127.0.0.1")).toEqual(["https://127.0.0.1", "http://127.0.0.1"]);
    expect(originsForDomain("localhost")).toEqual(["https://localhost", "http://localhost"]);
    expect(originsForDomain("")).toEqual([]);
  });
});

describe("listCookies", () => {
  const jar = [
    cookie({ name: "plain", domain: ".example.com" }),
    cookie({
      name: "chips",
      domain: ".widget.com",
      partitionKey: { topLevelSite: "https://example.com" },
    }),
    cookie({ name: "other-store", domain: ".example.com", storeId: "1" }),
  ];
  it("merges unpartitioned and partitioned cookies without duplicates", async () => {
    const api = fakeBrowser(jar);
    const cookies = await listCookies(api, "0");
    expect(cookies.map((c) => c.name).sort()).toEqual(["chips", "plain"]);
    expect(api.getAllCalls).toEqual([{ storeId: "0" }, { storeId: "0", partitionKey: {} }]);
    expect(planningDomains(cookies)).toEqual(["example.com"]);
  });
  it("tolerates browsers without partitionKey support", async () => {
    const api = fakeBrowser(jar, "chrome-old");
    const cookies = await listCookies(api, "0");
    expect(cookies.map((c) => c.name)).toEqual(["plain"]);
  });
  it("forwards the domain filter", async () => {
    const api = fakeBrowser(jar);
    await listCookies(api, "0", "example.com");
    expect(api.getAllCalls[0]).toEqual({ storeId: "0", domain: "example.com" });
  });
});

describe("cleanDomainsInStore", () => {
  const jar = [
    cookie({ name: "sid", domain: ".example.com", secure: true, path: "/" }),
    cookie({ name: "pref", domain: "www.example.com", path: "/app" }),
    cookie({ name: "keep", domain: ".keep.com" }),
    cookie({ name: "other", domain: ".example.com", storeId: "1" }),
    cookie({
      name: "chips",
      domain: ".widget.com",
      secure: true,
      partitionKey: { topLevelSite: "https://example.com", hasCrossSiteAncestor: true },
    }),
  ];

  it("removes only cookies whose planning domain is targeted, in the given store", async () => {
    const api = fakeBrowser(jar);
    const result = await cleanDomainsInStore(api, "0", [".example.com", "www.example.com"], {
      cleanSiteData: false,
    });
    expect(result.cookiesRemoved).toBe(3);
    expect(result.cookiesFailed).toBe(0);
    expect(result.domains).toEqual(["example.com", "www.example.com"]);
    expect(api.removeCalls).toEqual([
      { url: "https://example.com/", name: "sid", storeId: "0" },
      { url: "http://www.example.com/app", name: "pref", storeId: "0" },
      {
        url: "https://widget.com/",
        name: "chips",
        storeId: "0",
        partitionKey: { topLevelSite: "https://example.com", hasCrossSiteAncestor: true },
      },
    ]);
    expect(api.jar.map((c) => c.name).sort()).toEqual(["keep", "other"]);
    expect(api.browsingDataCalls).toEqual([]);
    expect(result.siteDataMode).toBe("none");
  });

  it("counts failures without aborting", async () => {
    const api = fakeBrowser(jar);
    api.failRemoveFor.add("sid");
    const result = await cleanDomainsInStore(api, "0", ["example.com", "www.example.com"], {
      cleanSiteData: false,
    });
    expect(result.cookiesRemoved).toBe(2);
    expect(result.cookiesFailed).toBe(1);
  });

  it("is a no-op for an empty domain list", async () => {
    const api = fakeBrowser(jar);
    const result = await cleanDomainsInStore(api, "0", [], { cleanSiteData: true });
    expect(result.cookiesRemoved).toBe(0);
    expect(api.getAllCalls).toEqual([]);
    expect(api.browsingDataCalls).toEqual([]);
  });

  it("uses a supplied cookie list instead of calling getAll", async () => {
    const api = fakeBrowser(jar);
    const result = await cleanDomainsInStore(api, "0", ["keep.com"], { cleanSiteData: false }, [
      cookie({ name: "keep", domain: ".keep.com" }),
    ]);
    expect(api.getAllCalls).toEqual([]);
    expect(result.cookiesRemoved).toBe(1);
  });

  it("clears site data with origins on Chrome", async () => {
    const api = fakeBrowser(jar);
    const result = await cleanDomainsInStore(api, "0", ["example.com"], {
      cleanSiteData: true,
      extraHosts: ["shop.example.com"],
    });
    expect(result.siteDataMode).toBe("origins");
    expect(result.siteDataDomains).toBe(2);
    expect(result.siteDataFailed).toBe(false);
    expect(api.browsingDataCalls).toHaveLength(1);
    expect(api.browsingDataCalls[0]?.types).toEqual(CHROME_SITE_DATA_TYPES);
    expect(api.browsingDataCalls[0]?.options).toEqual({
      origins: [
        "https://example.com",
        "http://example.com",
        "https://www.example.com",
        "http://www.example.com",
        "https://shop.example.com",
        "http://shop.example.com",
      ],
    });
  });

  it("falls back to hostnames and Firefox data types on Firefox", async () => {
    const api = fakeBrowser(jar, "firefox");
    const result = await cleanDomainsInStore(api, "0", ["example.com"], { cleanSiteData: true });
    expect(result.siteDataMode).toBe("hostnames");
    expect(result.siteDataFailed).toBe(false);
    expect(api.browsingDataCalls).toHaveLength(2);
    expect(api.browsingDataCalls[1]).toEqual({
      options: { hostnames: ["example.com", "www.example.com"] },
      types: FIREFOX_SITE_DATA_TYPES,
    });
  });

  it("reports site-data failure when both shapes are rejected", async () => {
    const api = fakeBrowser(jar);
    api.browsingData = {
      async remove() {
        throw new Error("nope");
      },
    };
    const result = await cleanDomainsInStore(api, "0", ["example.com"], { cleanSiteData: true });
    expect(result.cookiesRemoved).toBe(2);
    expect(result.siteDataFailed).toBe(true);
    expect(result.siteDataMode).toBe("none");
  });

  it("skips site data when the API is unavailable", async () => {
    const api = fakeBrowser(jar);
    delete api.browsingData;
    const result = await cleanDomainsInStore(api, "0", ["example.com"], { cleanSiteData: true });
    expect(result.siteDataMode).toBe("none");
    expect(result.siteDataFailed).toBe(false);
  });

  it("clears site data for extra hosts even when no cookies matched", async () => {
    const api = fakeBrowser([]);
    const result = await cleanDomainsInStore(api, "0", ["gone.com"], {
      cleanSiteData: true,
      extraHosts: ["app.gone.com"],
    });
    expect(result.cookiesRemoved).toBe(0);
    expect(result.siteDataDomains).toBe(2);
  });

  it("clears site data for extra hosts when the site has no cookie domains at all", async () => {
    const api = fakeBrowser([]);
    const result = await cleanDomainsInStore(api, "0", [], {
      cleanSiteData: true,
      extraHosts: ["app.gone.com"],
    });
    expect(api.getAllCalls).toEqual([]);
    expect(result.siteDataDomains).toBe(1);
    expect(api.browsingDataCalls[0]?.options).toEqual({
      origins: ["https://app.gone.com", "http://app.gone.com"],
    });
  });
});

describe("executePlan end-to-end with the planner", () => {
  it("removes cookies for closed sites and keeps open/whitelisted ones", async () => {
    const jar = [
      cookie({ name: "a", domain: ".closed.com" }),
      cookie({ name: "b", domain: "www.closed.com", secure: true }),
      cookie({ name: "c", domain: ".open.com" }),
      cookie({ name: "d", domain: ".white.com" }),
      cookie({ name: "e", domain: ".closed.com", storeId: "1" }),
    ];
    const api = fakeBrowser(jar);
    const cookiesByStore = {
      "0": await listCookies(api, "0"),
      "1": await listCookies(api, "1"),
    };
    const plan = planCleanup({
      openTabHosts: { "0": ["https://open.com/"], "1": ["https://closed.com/"] },
      cookieDomains: {
        "0": planningDomains(cookiesByStore["0"]),
        "1": planningDomains(cookiesByStore["1"]),
      },
      lists: [{ pattern: "white.com", listType: "white" }],
      greyExpiredAtRestart: false,
      trigger: "tab-close",
    });
    const results = await executePlan(api, plan, { cleanSiteData: false }, cookiesByStore);
    expect(results.map((r) => [r.storeId, r.cookiesRemoved])).toEqual([
      ["0", 2],
      ["1", 0],
    ]);
    expect(api.jar.map((c) => c.name).sort()).toEqual(["c", "d", "e"]);
  });
});

describe("countCookiesForHost", () => {
  it("counts cookies for the site of a host across partitions", async () => {
    const api = fakeBrowser([
      cookie({ name: "a", domain: ".example.com" }),
      cookie({ name: "b", domain: "shop.example.com" }),
      cookie({ name: "c", domain: ".other.com" }),
      cookie({ name: "d", domain: ".example.com", storeId: "1" }),
    ]);
    expect(await countCookiesForHost(api, "0", "www.example.com")).toBe(2);
    expect(await countCookiesForHost(api, "1", "example.com")).toBe(1);
    expect(await countCookiesForHost(api, "0", "nothing.net")).toBe(0);
    expect(await countCookiesForHost(api, "0", "")).toBe(0);
  });
});

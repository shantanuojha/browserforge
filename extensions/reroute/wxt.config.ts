import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  imports: false,
  manifest: ({ mode, browser }) => ({
    name: "Reroute - URL Rewrite Rules",
    short_name: "Reroute",
    description:
      "Redirect and rewrite URLs with wildcard or regex rules, and strip tracking parameters automatically. Imports Redirector rules.",
    permissions: [
      "declarativeNetRequest",
      // `onRuleMatchedDebug` diagnostics only run under `import.meta.env.DEV`, and Chrome only
      // delivers the event to unpacked extensions, so the permission is dev-only too.
      ...(mode === "development" ? ["declarativeNetRequestFeedback"] : []),
      "webNavigation",
      "tabs",
      "storage",
      "contextMenus",
      // Periodic licence revalidation (`@browserforge/licensing` scheduleRevalidation).
      "alarms",
    ],
    // `<all_urls>` is needed for redirects on any site; it also covers the only API Reroute calls,
    // https://api.lemonsqueezy.com/* (licence activation/validation).
    host_permissions: ["<all_urls>"],
    action: { default_title: "Reroute" },
    options_ui: { page: "options.html", open_in_tab: true },
    declarative_net_request: {
      rule_resources: [
        // Static, build-time generated tracking-parameter rules (from the ClearURLs catalog).
        { id: "tracking-params", enabled: true, path: "rules/tracking-params.json" },
      ],
    },
    // Firefox needs a stable add-on id; Chrome warns about the key, so only emit it for Firefox.
    ...(browser === "firefox"
      ? { browser_specific_settings: { gecko: { id: "reroute@shantanuojha.com" } } }
      : {}),
  }),
  zip: {
    sourcesRoot: "../../",
    excludeSources: ["extensions/arbor/**", "extensions/cookiesweep/**", "**/.env*"],
  },
});

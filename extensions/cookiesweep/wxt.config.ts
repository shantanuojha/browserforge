import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  imports: false,
  manifest: {
    name: "CookieSweep - Auto-delete cookies",
    short_name: "CookieSweep",
    description:
      "Deletes cookies and site data automatically when you close a site's tabs, except for the sites you whitelist. Imports Cookie AutoDelete settings.",
    permissions: [
      "cookies",
      "browsingData",
      "tabs",
      "storage",
      "alarms",
      "webNavigation",
      "contextMenus",
    ],
    host_permissions: ["<all_urls>"],
    action: { default_title: "CookieSweep" },
    options_ui: { page: "options.html", open_in_tab: true },
    browser_specific_settings: {
      gecko: { id: "cookiesweep@browserforge.dev" },
    },
  },
  zip: {
    sourcesRoot: "../../",
    excludeSources: ["extensions/arbor/**", "extensions/reroute/**", "site/**", "**/.env*"],
  },
});

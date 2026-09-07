import { defineConfig } from "wxt";

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  imports: false, // explicit imports only; easier to review and lint
  manifest: {
    name: "Arbor - Tree Tabs & Sessions",
    short_name: "Arbor",
    description:
      "Tree-style tab manager and session keeper. Save, annotate and restore your windows without ever losing a tab.",
    permissions: [
      "tabs",
      "storage",
      "unlimitedStorage",
      "sidePanel",
      "alarms",
      "sessions",
      "favicon",
    ],
    optional_permissions: ["identity"],
    action: { default_title: "Arbor" },
    side_panel: { default_path: "sidepanel.html" },
    commands: {
      _execute_action: {
        suggested_key: { default: "Alt+Shift+A" },
        description: "Open Arbor",
      },
    },
    browser_specific_settings: {
      gecko: { id: "arbor@browserforge.dev" },
    },
  },
  zip: {
    // Firefox reviewers rebuild from the sources zip: include the whole monorepo minus siblings.
    sourcesRoot: "../../",
    excludeSources: ["extensions/reroute/**", "extensions/cookiesweep/**", "site/**", "**/.env*"],
  },
});

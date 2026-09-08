import { defineConfig } from "wxt";

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  imports: false, // explicit imports only; easier to review and lint
  manifest: ({ browser }) => ({
    name: "Arbor - Tree Tabs & Sessions",
    short_name: "Arbor",
    description:
      "Tree-style tab manager and session keeper. Save, annotate and restore your windows without ever losing a tab.",
    // Every permission here is used by shipped code. Google Drive backup (optional `identity`) is
    // not implemented yet and is hidden behind DRIVE_BACKUP_ENABLED in the options page; add the
    // optional permission back when it ships.
    permissions: ["tabs", "storage", "unlimitedStorage", "sidePanel", "alarms", "favicon"],
    // Licence activation/validation (Lemon Squeezy License API). The only host Arbor talks to.
    host_permissions: ["https://api.lemonsqueezy.com/*"],
    action: { default_title: "Arbor" },
    side_panel: { default_path: "sidepanel.html" },
    commands: {
      _execute_action: {
        suggested_key: { default: "Alt+Shift+A" },
        description: "Open Arbor",
      },
    },
    // Firefox needs a stable add-on id; Chrome warns about the key, so only emit it for Firefox.
    ...(browser === "firefox"
      ? { browser_specific_settings: { gecko: { id: "arbor@shantanuojha.com" } } }
      : {}),
  }),
  zip: {
    // Firefox reviewers rebuild from the sources zip: include the whole monorepo minus siblings.
    sourcesRoot: "../../",
    excludeSources: ["extensions/reroute/**", "extensions/cookiesweep/**", "**/.env*"],
  },
});

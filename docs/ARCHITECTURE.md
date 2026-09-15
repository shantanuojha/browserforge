# Architecture

How the BrowserForge extensions are layered, which side of a boundary a file belongs on, and the
words we use for things. `docs/CODE-STANDARDS.md` has the rules that keep it this way.

## Layers

Every extension is a small ports-and-adapters application. Dependencies point inwards only:

```
entrypoints/  ->  adapters/  ->  lib/background/ (application)  ->  lib/ (domain)
components/, hooks/  ->  adapters/, lib/
```

| Layer           | Location                                                      | May import                                                  | Never imports                                         |
| --------------- | ------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| **Domain**      | `src/lib/**` (except `lib/background`)                        | `@browserforge/shared`, other `lib/` modules                | `wxt/*`, `browser.*`, `chrome.*`, React, `Date.now()` |
| **Application** | `src/lib/background/**`                                       | domain, port interfaces it declares itself                  | `wxt/*`, `browser.*`, `chrome.*`                      |
| **Adapters**    | `src/adapters/**`                                             | `wxt/browser`, `wxt/utils/storage`, `fetch`, ports from lib | UI                                                    |
| **Entrypoints** | `src/entrypoints/*.ts`                                        | adapters + application; registration and wiring only        | domain internals                                      |
| **UI**          | `src/components/**`, `src/hooks/**`, `entrypoints/**/App.tsx` | `@browserforge/ui`, adapters, domain (pure helpers)         | `lib/background` (talk to it through messages)        |

The same split applies to the packages:

- `@browserforge/shared` is pure TypeScript (no DOM, no `chrome.*` at import time): guards, base64,
  env readers, `Clock`, domain matching, `createMessageListener`, the logger, `Result`.
  `storage.ts` is the one adapter it hosts; it reads `chrome.storage` at call time only.
- `@browserforge/licensing` is a domain package. `LicenseApi` (the Lemon Squeezy endpoints) and
  `LicenseStorage` are ports; `createLicenseApi` is the production adapter over `fetch`.
  `license-record.ts` holds the persisted shape and the pure rules that turn it into a state.
- `@browserforge/ui` is React only. Presentation rules (`licenseSummary.ts`) are pure functions;
  side effects that every page needs (`dom.ts`: download, clipboard) live once, here.

## Ports and adapters

A **port** is a TypeScript interface declared next to the service that needs it, sized for that
service only (interface segregation). An **adapter** implements a port over a browser API and is
the only place that API is touched. Tests hand in an in-memory implementation; the background
entrypoint hands in the browser one.

| Port                                                   | Declared in                                                         | Production adapter                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `DnrPort`                                              | reroute `lib/background/rule-deployer.ts`                           | `adapters/dnr.ts`                                                    |
| `RedirectTabsPort`, `ContentScriptMessenger`           | reroute `lib/background/redirect-fallback.ts`, `copy-clean-link.ts` | `adapters/tabs.ts`                                                   |
| `SyncArea` / `SyncStore`                               | reroute `lib/sync/store.ts`                                         | `adapters/sync-area.ts`                                              |
| `ActivityLogStore`, `ValueStore<T>`                    | reroute `lib/background/*`                                          | WXT storage items in `adapters/storage.ts`                           |
| `ExecutorApi`                                          | cookiesweep `lib/executor.ts`                                       | `adapters/extension-api.ts`                                          |
| `SessionStore`, `AlarmsPort`                           | cookiesweep `lib/background/scheduler.ts`                           | `adapters/session-store.ts`, `adapters/alarms.ts`                    |
| `BadgePainter`                                         | cookiesweep `lib/background/badge.ts`                               | `adapters/badge-painter.ts`                                          |
| `StoreRegistry` deps, `ActivityLog`, `CleanupNotifier` | cookiesweep `lib/background/*`                                      | wired in `entrypoints/background.ts`                                 |
| `TabsPort`, `TrackerEventSink`                         | arbor `lib/sync/types.ts`                                           | `adapters/tabs-port.ts`, `adapters/tracker-events.ts`                |
| `TreeStore` / `LogBackend`                             | arbor `lib/store/types.ts`                                          | `adapters/indexeddb-store.ts` (`MemoryTreeStore` in tests)           |
| `BackupRepository`                                     | arbor `lib/backups.ts`                                              | `adapters/backup-store.ts`                                           |
| `AlarmsPort`, `SettingsStore`                          | arbor `lib/background/ports.ts`                                     | `adapters/alarms.ts`, `adapters/settings-store.ts`                   |
| `MessageTransport`, `TreePortSink`                     | arbor `lib/messaging.ts`, `lib/background/tree-broadcaster.ts`      | `adapters/messaging.ts`, `adapters/tree-port.ts`                     |
| `LicenseApi`, `LicenseStorage`, `AlarmsLike`           | `@browserforge/licensing`                                           | `createLicenseApi(fetch)`, `browser.storage.local`, `browser.alarms` |
| `Clock`                                                | `@browserforge/shared`                                              | `systemClock`                                                        |

Rules of thumb:

- Time comes in as a `Clock` (`() => number`), never from `Date.now()` inside domain code.
- Randomness that matters (sync origin ids) is generated in the entrypoint and passed in.
- Adapters are thin: convert types, catch browser-specific failures, nothing else. If an adapter
  grows a decision, that decision moves into the application layer behind a port.
- The `browser` object is imported in `adapters/`, `entrypoints/`, `hooks/` and `components/`
  only. `lib/` has no framework imports. Arbor goes one step further: only `adapters/` imports
  `wxt/browser`, `chrome.*` or `indexedDB`; its hooks, components and entrypoints call adapters.

## Background services

All three extensions follow the same shape. The entrypoint builds the services with the browser
adapters, then registers listeners in a handful of small `register*` functions. All behaviour is
in `lib/background`, unit-tested with fakes, and covered end to end by `src/background.test.ts`
running the real entrypoint against `@webext-core/fake-browser` (Reroute, CookieSweep) or by
`lib/background/service.test.ts` over in-memory ports (Arbor).

**Reroute** (`lib/background/service.ts` composes):

- `rule-deployer` compiles user rules and the allowlist to `declarativeNetRequest` and demotes
  what the browser rejects to the JavaScript fallback.
- `redirect-fallback` redirects on `webNavigation` for rules DNR cannot express, with per-tab
  loop protection.
- `sync-mirror` mirrors rules into `storage.sync` (Pro) without echo loops.
- `activity-recorder` keeps the rolling activity log.
- `copy-clean-link` serves the context-menu entry.

**CookieSweep** (`entrypoints/background.ts` composes):

- `cleanup-runner` snapshots tabs and cookies, asks the pure `planner` what to remove and the
  `executor` to remove it.
- `scheduler` coalesces triggers, honours the delay and survives worker restarts through session
  storage and alarms.
- `badge` decides what the toolbar badge shows (pure) and paints it (port).
- `store-registry` remembers cookie stores the browser stops listing.
- `tab-hosts` classifies committed navigations as "left the site" or not.

**Arbor** (`lib/background/service.ts` composes; `entrypoints/background.ts` wires adapters):

- `service` opens the store, mirrors the browser through the tracker, keeps the compaction and
  backup alarms honest, and offers the operations the message handlers call (add node, import,
  restore snapshot, backup now).
- `message-handler` is three tables from message definition to handler; every handler waits for
  startup. `tree-broadcaster` pushes the tree to connected side panels, debounced.
- `lib/sync` is the tracker, one module per responsibility behind the `TabTracker` facade:
  `live-books` (the browser's own state), `tree-writer` (window node on demand, tab nodes,
  patches, save-or-drop), `placement` (tree position vs strip position, detached rules),
  `pruning` (untitled containers left empty), `adoption` (restores in flight), `mirror` (the
  browser events), `rebuild` + `matchers` (re-matching on startup: by live id, by URL overlap),
  `reopen` + `containers` (focus, close-and-save, restore, reopen in place or as a window),
  `edits` (remove from tree without touching the browser, close-and-remove, and move with the
  browser following), `history-runner` (undo/redo steps as a table keyed by kind).
- `lib/model` and `lib/history` are pure: op appliers, coercers and step runners are tables keyed
  by op or step kind, so a new kind is one entry each. The op-log, snapshot and export formats
  are the same as before the refactor.
- The side panel is `entrypoints/sidepanel/App.tsx` composing `components/panel/*` with hooks
  (`useTreeState`, `useHistory`, `useTreeActions`, `useToast`, `usePanelShortcuts`); the tree
  itself is `TreeView` over `useTreeSelection`, `useVirtualRows`, `useTreeDrag`,
  `useTreeKeyboard` and the pure `lib/tree-search`, `lib/tree-layout`, `lib/tree-menu`.

## Vocabulary

Use these words in code, one per concept. UI copy may differ where the product already says
something else; keep the two consistent within a product.

| Term                     | Meaning                                                                                                                                | Not                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **rule**                 | Reroute: one user-defined redirect (`Rule` in `lib/rules/model.ts`).                                                                   | redirect, entry             |
| **pattern**              | The matching side of a rule (`include`, `exclude`) or of a list entry.                                                                 | expression, filter          |
| **target**               | Where a rule redirects to (`redirectTo` on the model, `target` on a match).                                                            | destination, result URL     |
| **DNR rule**             | A compiled `declarativeNetRequest` rule (`DnrRule`). Never called just "rule" in code.                                                 |                             |
| **allowlist**            | Reroute: hosts where Reroute does nothing. Code says `allowlist`; the UI says "Allowlist".                                             | whitelist, exceptions       |
| **whitelist / greylist** | CookieSweep: `ListType` `"white"` / `"grey"`; kept because the product, its import format and Cookie AutoDelete users use these words. | allowlist, blocklist        |
| **list entry**           | CookieSweep: one `ListEntry` (pattern + list type + optional store).                                                                   | rule                        |
| **cookie store**         | A browser cookie jar (default, container, incognito), identified by `storeId`.                                                         | container, profile          |
| **site**                 | The registrable-ish domain `siteOf()` returns; the unit the planner protects.                                                          | domain (when you mean site) |
| **host**                 | A hostname as it appears in a URL or cookie domain (normalised, no leading dot).                                                       | domain, url                 |
| **trigger**              | CookieSweep: why a cleanup runs (`CleanupTrigger`).                                                                                    | reason, source              |
| **plan**                 | CookieSweep: the planner's verdict per store (`StorePlan`, `CleanupPlan`).                                                             |                             |
| **port**                 | An interface a service depends on; **adapter**: its browser-backed implementation.                                                     | api, service (for the port) |
| **store** (storage)      | A typed slot in extension storage (`ValueStore`, `SyncStore`, `SessionStore`).                                                         | repo                        |
| **licence / license**    | British spelling in UI copy and prose; `license` in identifiers and file names.                                                        |                             |
| **Pro**                  | The paid tier. `isPro()` answers whether it is active; a **feature gate** decides per feature.                                         | premium, paid               |
| **node / container**     | Arbor's tree vocabulary; see `extensions/arbor/README.md`.                                                                             | folder, window (in code)    |

## Tests

- Domain and application code: colocated `*.test.ts`, no browser, in-memory ports
  (`lib/background/testing.ts` in Reroute, `lib/sync/testing/fake-browser.ts` in Arbor,
  `@browserforge/licensing/testing` for licensing).
- Adapters and wiring: `src/background.test.ts` drives the real entrypoint against
  `@webext-core/fake-browser` plus hand-rolled stubs for APIs the fake lacks. Arbor's adapter
  tests sit next to the adapters (`adapters/*.test.ts`, with `adapters/testing/fake-indexeddb.ts`).
- Test doubles are shared, not copied: `createMemoryStorage`, `createFakeFetch` and the Lemon
  Squeezy body builders live in `@browserforge/licensing/testing`.

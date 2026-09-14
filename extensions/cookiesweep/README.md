# CookieSweep — auto-delete cookies and site data

Queued for store slot 3 (new publishers are capped at two listings). Free; reputation anchor.

## Why it exists

Cookie AutoDelete (280K users) died with MV2. Every MV3 successor on the store totals ~22K users; the
only Featured one is closed source and paywalls site-data cleanup. CookieSweep is open source,
free, imports Cookie AutoDelete settings and cleans localStorage/IndexedDB/cache for free.

## Scope (Phase 5)

- Triggers: tab closed (`tabs.onRemoved`), domain changed in a tab (`webNavigation.onCommitted`
  main frame), browser startup (`runtime.onStartup`), manual "clean now".
- Cleanup planner (`src/lib/planner.ts`, pure, fully unit-tested): given open tabs, the whitelist /
  greylist (greylist = keep until browser restart), and the set of cookie domains, decide which
  domains are safe to clean. Never clean a domain that still has an open tab; a tab that is
  mid-navigation owns both its `url` and its `pendingUrl`. Respect the shared
  `hostMatchesPattern` semantics from `@browserforge/shared`. Patterns are stored in the ASCII
  (punycode) form cookie domains use, so `münchen.de` matches `xn--mnchen-3ya.de`.
- Executor: `cookies.getAll` per cookie store (incl. partitioned cookies via `partitionKey`),
  `cookies.remove`, `browsingData.remove({ origins }, { localStorage, indexedDB, cacheStorage,
serviceWorkers })` (Chrome 74+ `origins` filter), optional delay via `alarms` (default 15 s).
  Runs never overlap: triggers arriving during a run collapse into one follow-up run.
- Containers/stores: iterate `cookies.getAllCookieStores()` plus every store id seen before
  (`cookiesweep:knownStores`). The browser only lists stores that currently own a tab (Firefox
  always, Chrome for incognito), so a container would otherwise drop out of the list exactly when
  its last tab closes. A remembered store the browser rejects is forgotten again. Incognito is
  handled if the extension is allowed in incognito.
- Background tests (`src/background.test.ts`) drive the real entrypoint against fake-browser and
  simulate service-worker restarts; sub-30 s timers lost with a worker are re-armed from the
  pending trigger kept in `storage.session`.
- Options: whitelist/greylist editor with wildcard patterns, import Cookie AutoDelete settings
  export (its JSON has `domain`, `listType` WHITE|GREY, `storeId`, `expression`), export ours,
  activity log (last 500 cleanups), notification toggle, delay setting, "also clean site data" toggle
  (default on).
- Popup: current site status (protected / will be cleaned), add to whitelist/greylist, clean this
  site now, global pause.
- Badge: count of cookies for the active site.

## Constraints

- No remote code, no network calls at all.
- Keep the permission set as declared; `<all_urls>` is required for `cookies` across sites and
  `browsingData` origin filters. Document justification for the store listing.

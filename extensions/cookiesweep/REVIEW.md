# CookieSweep review (branch `review/cookiesweep-licensing`)

Scope: every file under `extensions/cookiesweep/src`, plus the `@browserforge/shared` helpers it
depends on (`normalizeHost`, `hostMatchesPattern`, `siteOf`) read-only. Method: read everything,
form a hypothesis, write a failing vitest test, fix minimally, record here. Platform behaviour
was verified from primary sources where it mattered (Firefox `ext-cookies.js`, Cookie AutoDelete
`Libs.ts` / `Expressions.tsx`); nothing below relies on memory of an API.

Test count: 78 before, 96 after (`pnpm --filter @browserforge/cookiesweep test`). The new
`src/background.test.ts` drives the real background entrypoint against `@webext-core/fake-browser`
and can simulate service-worker death and restart; `README.md` describes it.

## Confirmed and fixed

### 1. Medium: whitelist patterns with non-ASCII labels never matched (`57ca68f`)

- Cause: `normalizePattern()` stored patterns as typed. Cookie domains from `cookies.getAll()` and
  tab hostnames from `new URL().hostname` are always ASCII/punycode, so `münchen.de` (or a Cookie
  AutoDelete `*.münchen.de`) passed `isValidPattern()` and then never matched
  `xn--mnchen-3ya.de`. The popup showed "Will be cleaned" for a whitelisted site and its cookies
  were deleted. `localhost:3000` was accepted and inert for the same reason (cookie domains never
  carry a port).
- Evidence: `settings.test.ts` "stores internationalised hostnames in the punycode form",
  `planner.test.ts` "a whitelist entry typed in Unicode protects the punycode cookie domain",
  `importer.test.ts` "imports internationalised expressions in the form cookies use".
- Fix: `toAsciiHost()` in `settings.ts` runs the body through the URL parser (IDNA + port strip,
  only when the input contains a non-ASCII character or a colon, so ASCII input is untouched);
  `isValidPattern()` rejects any remaining colon except inside a bracketed IPv6 literal. Stored
  patterns are therefore shown in punycode in the list editor; the popup's "Add to whitelist"
  already produced punycode for such sites, so the display is now consistent.

### 2. Medium: the site a tab was navigating _to_ was not protected (`3a7d8db`)

- Cause: `runCleanup()` used `tab.url || tab.pendingUrl`, i.e. only the committed URL. While a
  tab loads site B (still showing A), a cleanup triggered by another tab closing saw only A open
  and deleted B's cookies; the user arrived at B logged out. With the default 15 s delay this
  window is easy to hit (close a tab, then click a link elsewhere within 15 s).
- Evidence: `background.test.ts` "protects the site a tab is navigating to (pendingUrl)".
- Fix: both `url` and `pendingUrl` of every tab feed the planner's open-tab set.

### 3. Medium: Firefox container cookies were never cleaned after the container's last tab closed (`3a7d8db`)

- Cause: `runCleanup()` iterated only `cookies.getAllCookieStores()`. Firefox builds that list
  from open tabs (`toolkit/components/extensions/parent/ext-cookies.js`, `getAllCookieStores`
  loops `tabManager.query()`), so a container disappears from it the instant its last tab closes,
  which is exactly the moment CookieSweep wants to clean it. Chrome does the same for the
  incognito store, but Chrome wipes incognito cookies itself, so only Firefox users were affected.
  Safe-side failure (nothing extra deleted), but the headline feature did not work for containers.
- Evidence: `background.test.ts` "keeps cleaning a container whose last tab closed even though the
  browser no longer lists it" and "forgets a remembered store once the browser rejects it".
- Fix: store ids seen in `getAllCookieStores()` are remembered in `storage.local`
  (`cookiesweep:knownStores`) and included in every run with an empty tab list. A remembered store
  the browser rejects (`cookies.getAll` throws, e.g. Chrome incognito profile gone) is forgotten
  again, so there is one warning, not one per run.

### 4. Medium (Firefox): Reader View lost the article site's protection and triggered a cleanup (`54b5f4b`)

- Cause: Firefox rewrites the tab URL to `about:reader?url=<encoded>`. `hostFromTabUrl()` treated
  every `about:` URL as "cannot own cookies", so (a) the site lost its open-tab protection and (b)
  the `webNavigation.onCommitted` transition into Reader View looked like leaving the site and
  scheduled a `domain-change` cleanup that deleted the site's cookies while the user was reading.
- Evidence: `planner.test.ts` "sees through Firefox Reader View to the article's site".
- Fix: unwrap the `url` query parameter and evaluate that.

### 5. Low: bursts of tab closes with `delaySeconds: 0` ran concurrent cleanups (`3a7d8db`)

- Cause: each `tabs.onRemoved` called `runPendingCleanup()` directly. Closing a window with N
  tabs ran N overlapping `runCleanup()` calls that each listed and "removed" the same cookies.
  Chrome's `cookies.remove` echoes the details for a cookie that no longer exists, so every run
  counted every cookie and wrote its own activity-log entry. Default settings (15 s) coalesce via
  the timer, so only users who set the delay to 0 saw it.
- Evidence: `background.test.ts` "runs one cleanup for a burst of tab closes instead of racing
  several" (6 removals and 3 log entries for 2 cookies before the fix).
- Fix: runs are chained; triggers arriving while a run is in progress collapse into exactly one
  follow-up run (needed because a tab closed after the first snapshot must still be handled).

### 6. Low: a sub-30 s cleanup pending when the worker died was lost (`3a7d8db`)

- Cause: delays under 30 s use `setTimeout`, which dies with the service worker; the pending
  trigger stayed in `storage.session` and was only picked up by the next tab event. The options
  page documented this as a limitation. In practice the 30 s idle timeout makes it rare, but
  memory-pressure termination and abnormal restarts do happen.
- Evidence: `background.test.ts` "resumes a short-delay cleanup that was pending when the worker
  died".
- Fix: on worker start, if a pending trigger exists and no alarm is registered for it, the
  cleanup is re-scheduled. Options hint updated.

### 7. Low: Cookie AutoDelete imports carried its internal `_Default:*` entries and an inert `private` store (`57ca68f`)

- Cause: CAD's "Create default options" stores per-container settings as pseudo-expressions
  `_Default:WHITE` / `_Default:GREY` with `storeId` `"0"` or `"firefox-default"`
  (`src/ui/settings/components/Expressions.tsx`, `createDefaultOptions`). They imported as
  whitelist patterns `_default:white`. CAD's `getStoreId()` (`src/services/Libs.ts`) also rewrites
  Chrome's incognito store `"1"` to `"private"` before saving, so entries scoped to it never
  applied on Chrome.
- Evidence: `importer.test.ts` "reads the real CAD 'Export expressions' file" (the export root is
  `StoreIdToExpressionList`, from `downloadObjectAsJSON(this.props.lists)`), "maps CAD's Chrome
  incognito alias 'private'".
- Fix: skip `_Default:*` with a clear reason; map `private` to `"1"` (`firefox-private` is already
  a real store id and is left alone).

## Verified correct (no change)

- Tab-close does not need the closed tab's URL: the planner re-derives open sites from the tabs
  that remain, so `tabs.onRemoved` carrying no URL is fine (`background.test.ts` "does not need
  the closed tab's URL").
- Delays of 30 s or more use `alarms` and survive a worker restart; the pending trigger lives in
  `storage.session` (`background.test.ts` "uses an alarm for delays of 30 s or more").
- Startup in grey-only scope expires the greylist, keeps unlisted domains and keeps greylisted
  domains that a restored tab still uses (`background.test.ts` "expires the greylist ...").
- `browsingData.remove` is always called with a non-empty `origins` (Chrome) or `hostnames`
  (Firefox) filter; an empty list short-circuits before the call, so it cannot wipe all site
  data. Both Chrome and Firefox reject unknown filter properties with a schema error rather than
  ignoring them, which the fallback relies on.
- `cookies.remove` URLs use `https` for `secure` cookies and the exact cookie path; HttpOnly and
  SameSite do not affect removal. Partitioned cookies pass their `partitionKey` through and are
  planned under their top-level site.
- Cookie AutoDelete's `*.example.com` also matches the apex (`globExpressionToRegExp` builds
  `(^|.)example\.com$`), so translating it to our `*example.com` is correct. CAD regex expressions
  (`/.../`) and CIDR ranges are rejected with a visible "Invalid pattern" reason.
- Activity log is capped at 500 entries (`appendActivity`), so storage growth is bounded.

## Unconfirmed (reasoning only, no code change)

- **Startup with `delaySeconds: 0` vs session restore.** `runtime.onStartup` runs the startup
  cleanup synchronously when the delay is 0. If Chrome has not yet populated `tabs.query()` with
  the tabs it is about to restore, greylisted (or, with "Full sweep on startup", all unlisted)
  domains of those tabs would be cleaned. Whether restored tabs are visible at `onStartup` time is
  a Chrome timing question I could not reproduce here. Mitigation if it shows up: enforce a
  minimum startup delay (e.g. 15 s) regardless of the setting.
- **`siteOf` heuristic.** Without a public-suffix list, a tab on `alice.github.io` protects cookies
  of `bob.github.io`, and `www.co.io` would not protect `.co.io`. The former is keep-side (safe);
  the latter is an exotic under-protection. A real PSL would fix both but lives in
  `@browserforge/shared` (out of scope) and adds a sizeable data file.
- **Popup list edits use React state, not fresh storage.** `patch({ lists: addListEntry(settings.lists, ...) })`
  merges from the popup's last-seen settings, so a list change made by the background (context-menu
  "Whitelist this site") in the same second could be overwritten. `settingsKey.watch` narrows the
  window to one storage round-trip; not reproduced.
- **Badge count excludes partitioned third-party cookies** because `countCookiesForHost` filters
  `cookies.getAll` by the site's domain. Cleanup is unaffected (it lists all cookies). Cosmetic.
- **Firefox `browsingData.remove({ hostnames })` coverage.** MDN documents `hostnames` for
  cookies, localStorage, indexedDB and serviceWorkers on current Firefox; if an older release
  ignored the filter for a type it would clear that type globally. Firefox 109+ (MV3 minimum) is
  fine per MDN; not runtime-verified here.

## Out of scope but noticed

- `@browserforge/shared` `normalizeHost` does not IDNA-encode; CookieSweep now does it locally.
  Reroute/Arbor call sites that accept typed hostnames would have the same mismatch.

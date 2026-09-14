# Reroute review (branch `review/reroute`, based on `origin/main` @ 6aea018)

Scope: every file under `extensions/reroute/src`, `wxt.config.ts`, `scripts/build-tracking-rules.mjs`,
the generated `public/rules/*`, and `packages/shared/src`. Nothing in arbor, cookiesweep, licensing or
ui was touched.

Method: read everything, then for each suspicion wrote a failing vitest first. Two harnesses were
added for that:

- `src/background.test.ts` drives the real `entrypoints/background.ts` on WXT's fake browser with
  in-memory `declarativeNetRequest` / `contextMenus` stubs (sync join, JS fallback, log, status).
- Chrome-engine semantics that no unit test can settle (RE2 support, `regexSubstitution`,
  `requestDomains`, `removeParams` composition, `tabs.update` with `javascript:`) were checked
  against the dev build loaded into Edge 140 through the Playwright harness at
  `~/.browserforge/release/.tools/pw` (`isRegexSupported`, `testMatchOutcome`, real navigations
  observed through `webNavigation`). Those scripts lived in `%TEMP%` and are not part of the repo;
  the observations they produced are quoted below.

Tests: **456 passing in 29 files before -> 499 passing in 32 files after.**
All gates green at every commit: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm --filter @browserforge/reroute build`.

Commits (oldest first):

| SHA       | Subject                                                                            |
| --------- | ---------------------------------------------------------------------------------- |
| `9c801a2` | sync join merges instead of wiping the remote rule set; add background harness     |
| `a6d30b4` | engine parity with Redirector and with DNR substitution                            |
| `1959be5` | import fidelity, duplicate ids on re-import, sync switch, undefined storage writes |
| `0824863` | tracking cleaner: provider rules must outrank and include the catch-all rule       |

---

## Confirmed bugs (fixed)

### 1. HIGH - Enabling Pro sync on a device wiped every other device's rules

- **Cause.** `settingsItem.watch -> rebuild -> scheduleSyncWrite` pushed the local rule list to
  `storage.sync` as soon as sync was switched on. On a fresh install that list is `[]`; every other
  device's `storage.onChanged` listener then adopted the empty snapshot (`rulesItem.setValue([])`).
- **Evidence.** `background.test.ts > enabling sync on a device with no rules adopts the remote set
instead of wiping it` failed with the sync snapshot equal to `[]` after the toggle; `... merges
both sets` failed with local `[l1]` only.
- **Fix.** On the off->on transition the background now reads the remote snapshot first and adopts
  `mergeRulesOnJoin(remote, local)` (remote order, then local-only ids); the normal rules watcher then
  publishes the union. Without a remote snapshot it publishes local as before. `sync.ts:
mergeRulesOnJoin` is unit-tested. Commit `9c801a2`.

### 2. HIGH - Tracking cleaner: provider parameters were never stripped on the network

- **Cause.** Chrome applies exactly one matching redirect rule per request (highest priority; ties
  broken by index order) and does **not** fall through when that rule's `removeParams` changes
  nothing. The generated ruleset gave the ClearURLs catch-all (rule 18, matches every frame request)
  and all 140 provider rules the same priority 1. The catch-all won the tie against every
  url-pattern-indexed provider rule and, being a no-op for e.g. YouTube's `si`, left it in place.
  The JS emulator (`cleanUrl`) unioned all matching rules, so "Copy clean link" and the tester
  disagreed with what the network layer did.
- **Evidence (Edge 140, dev build).**
  - `testMatchOutcome("https://www.youtube.com/watch?v=x&si=y")` -> `matchedRules: []`.
  - Real navigation `https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=abc` committed **unchanged**;
    with `&si=abc&utm_source=x` it committed as `...&si=abc` (only `utm_source` removed).
  - Isolated dynamic rules, equal priority, catch-all `[zzz]` vs `requestDomains: [tie.example]`
    `[si]`: `tie.example/?si=1&k=2` -> `matchedRules: []`, navigation untouched.
  - Specific rule at priority 2: `?si=1&zzz=2&k=3` -> one redirect to `?zzz=2&k=3`, then the now
    no-op specific rule shadowed the catch-all (`zzz` kept). Same for `?zzz=2&k=3` directly.
  - Unit: `catalog.test.ts > one-rule-per-request composition` (3 tests) and `cleanUrl > applies
only the winning rule, as the network layer does` failed before the fix.
- **Fix.** `toRemoveParamsRules` computes which conditions cover which (`conditionCovers`: catch-all
  covers all; `requestDomains` parent/subdomain; regex prefix such as `amazon` -> `amazon search`;
  a regex anchored on a literal host under a domain provider such as `LinkedIn Learning` under
  `LinkedIn`), takes the transitive closure, gives each rule priority `1 + |covering rules|` and
  merges the covering rules' parameters into it. Exceptions move to priority 10
  (`DNR_PRIORITY.trackingException`); the generator throws if nesting ever reaches that. `cleanUrl`
  applies only the highest-priority eligible rule (ties unioned). Ruleset regenerated from the same
  catalog: still 216 rules / 141 providers / 100 regex; file grows 86 KB -> 578 KB because every
  provider rule now carries the ~150 global parameters (inherent to the one-rule semantics).
  Re-verified in Edge: `youtube.com/...&si=abc`, `...&si=abc&utm_source=x&feature=share` and
  `youtu.be/...?si=abc` all commit at the clean `watch?v=...` URL; `testMatchOutcome` for the `si`
  URL now returns rule 67. Commit `0824863`.

### 3. MEDIUM - Wildcard `*` compiled to a greedy capture; Redirector's is lazy

- **Cause.** `wildcardToRegex` emitted `(.*)`. Redirector 3.5.3 `_preparePattern` emits `(.*?)`, so
  any imported rule with two or more `*` and `$n` in the target split differently.
- **Evidence.** `engine.test.ts > Redirector wildcard fidelity` (oracle = Redirector's algorithm
  verbatim): `https://example.com/*/*` -> `https://x.example/$2/$1` on `/a/b/c` gave
  `https://x.example/c/a/b`, Redirector gives `https://x.example/b/c/a`; 3 of 5 cases failed.
  RE2 honours the lazy quantifier identically (Edge navigation `lazy.example/a/b/c` ->
  `out.example/b/c/a`).
- **Fix.** `(.*?)`. Existing expectations updated. Commit `a6d30b4`.

### 4. MEDIUM - `anchorForDNR` mis-anchored regexes with top-level alternation

- **Cause.** `^a|b$` starts with `^` and ends with `$`, so it was passed to DNR unchanged, but each
  anchor only binds its own branch. `regexSubstitution` replaces the first match, so Chrome replaced
  a partial match.
- **Evidence.** `engine.test.ts > DNR / JS parity > top-level alternation ...` (DNR emulation)
  failed with `https://www.https://c.example/path?q=1`. Edge, real navigation with the old filter:
  `https://www.b.example/path?q=1` -> `https://www.https//c.example/path?q=1`; with the wrapped
  filter -> `https://c.example/path?q=1`, identical to the JS engine.
- **Fix.** `hasTopLevelAlternation` (escape/class/group aware); such sources are always wrapped
  `^.*?(?:src).*$`. Commit `a6d30b4`.

### 5. MEDIUM - Per-site allowlist: DNR ignored the `host` / `*.host` distinction

- **Cause.** `allowlistToDNR` collapsed every pattern into one `requestDomains` allow rule, and
  `requestDomains` always includes subdomains. The JS fallback uses `hostMatchesPattern` (exact /
  subdomains-only / both) and the Allowlist page documents those forms, so allowlisting
  `example.com` silently disabled all redirects and tracking cleanup on `mail.example.com`, and
  `*.example.com` also disabled the apex.
- **Evidence.** `engine.test.ts > allowlist DNR rules follow the same host semantics as the JS
fallback`: 3 of 11 cases disagreed with `hostMatchesAny`. Edge `testMatchOutcome` with the old
  rule: `https://www.example.com/p` matched the allow rule for an `example.com` entry.
- **Fix.** `*host` keeps `requestDomains`; exact hosts become one RE2 allow rule
  `^[^:/?#]+://(?:h1|h2)(?::\d+)?/`, `*.host` one `^[^:/?#]+://[^/?#]*\.(?:h)(?::\d+)?/`
  (ids `siteAllowBase`, `+1`, `+2`). Edge confirms: apex and `apex:8443` allowed, `www` redirected,
  `notexample.com` unmatched; subdomain rule allows `www`/`a.b` but not the apex. Commit `a6d30b4`.

### 6. LOW - Redirector import: `doubleUrlDecode`, legacy flags and `%`-encoded base64 not handled

- **Cause.** `PROCESS_MATCHES` lacked `doubleUrlDecode`; Redirector's `base64decode` unescapes the
  capture first when it contains `%` (padding arrives as `%3D`), ours went straight to `atob` and the
  rule silently never fired; pre-3.0 exports carry `unescapeMatches` / `escapeMatches` instead of
  `processMatches`.
- **Evidence.** `import-share.test.ts > maps processMatches ...`, `> base64decode works on captures
whose padding is URL-encoded` (returned `null`), `> honours the pre-3.0 unescapeMatches /
escapeMatches flags`. Source: Redirector `js/redirect.js` (`_includeMatch`, `_init`).
- **Fix.** Map `doubleUrlDecode`; `base64decode` -> `["decodeURIComponent", "atob"]`
  (`decodeURIComponent` is the identity on captures without `%`); legacy flags honoured when
  `processMatches` is absent. Commit `1959be5`.

### 7. LOW - Re-importing one's own export in "Add" mode produced duplicate rule ids

- **Cause.** `importRules(..., "append")` concatenated; Reroute JSON keeps ids, so restoring a backup
  next to the live rules yielded two rules per id (toggle/edit/delete acted on both, React keys
  collided).
- **Evidence.** `model.test.ts > appendRules re-ids imported rules that collide with existing ones`.
- **Fix.** `appendRules` in `model.ts`, used by the options page. Commit `1959be5`.

### 8. LOW - "Clear log" in the options page was undone by the next event

- **Cause.** The background kept its own copy of the log after the first `record()` and wrote it back
  in full on every event.
- **Evidence.** `background.test.ts > clearing the activity log ... is not undone by the next event`
  (two entries after clearing).
- **Fix.** `logItem.watch` keeps the in-memory copy in step. Commit `9c801a2`.

### 9. LOW - Status counted allowlist allow rules as "network rules"

- **Evidence.** `background.test.ts > status.dnrRules counts user rules only` (2 instead of 1).
- **Fix.** Count accepted user redirect rules only. Commit `9c801a2`.

### 10. LOW - `javascript:` accepted as a redirect target

- **Cause.** `isValidAbsoluteUrl` accepted any parseable scheme, so the tester showed "redirects to
  javascript:..." for a rule that can never fire.
- **Evidence.** `engine.test.ts > redirect target scheme`. Edge: `tabs.update(..., {url:
"javascript:alert(1)"})` -> `JavaScript URLs are not allowed in API based extension navigations.`
- **Fix.** Reject `javascript:` only (`about:`, `data:`, `chrome:` still allowed; `tabs.update`
  accepts them). Commit `a6d30b4`.

### 11. LOW - RE2 check let through escapes that JS and RE2 read differently

- **Cause.** `\A \z \Q \E \C \a` are identity escapes in JS (`"A"`, `"z"`, ...) but anchors /
  literal span / any byte / BEL in RE2. `isRegexSupported` cannot catch this: Edge reports
  `\Ahttps://a` and `\Qa.b\E` as supported.
- **Evidence.** `engine.test.ts > RE2 escapes that JS reads as plain letters`.
- **Fix.** `checkRE2Compatible` rejects them (rule falls back to JS). Commit `a6d30b4`.

### 12. LOW - Pro tab: sync switch stuck "on" once the licence lapsed

- **Cause.** `disabled={!isPro}` while `checked={syncEnabled}`.
- **Evidence.** `components/ProPanel.test.tsx` (SSR render) `> can always be turned off`.
- **Fix.** `disabled={!isPro && !syncEnabled}`. Commit `1959be5`.

### 13. LOW - `packages/shared` `StorageArea.set(key, undefined)` silently kept the old value

- **Cause.** `chrome.storage` drops `undefined` properties when serialising, so
  `set({ [key]: undefined })` is a no-op (fake-browser mirrors this).
- **Evidence.** `packages/shared/src/storage.test.ts > set(key, undefined) clears the key` (`"v"`
  remained).
- **Fix.** `undefined` -> `remove(key)`. `watch` now reports the fallback for the removal. Commit
  `1959be5`. (Reroute itself uses WXT storage; cookiesweep and arbor use this helper.)

---

## Unconfirmed suspicions (no code changed)

- **Sync: `storage.onChanged` only reacts to the `reroute.sync.meta` key.** If Chrome ever
  delivers a remote batch in several events (meta first, chunk later), `readRulesFromSync` returns
  `null` for the partial state and the later chunk event is ignored, so that update is missed until
  the next write. Chrome normally delivers a sync batch in one `onChanged`; I could not reproduce
  real multi-device sync propagation locally. Suggested hardening: react to any
  `reroute.sync.*` key and dedupe on `meta.updatedAt`.
- **First-match-wins across DNR and the JS fallback is not strictly guaranteed.** If rule A (JS-only)
  precedes rule B (DNR) and a URL matches both, DNR redirects to B's target at the network layer
  while the fallback calls `tabs.update(A.target)`; the tab ends at A's target after a wasted
  request. Correct end state, so not treated as a bug; noted as a design limitation.
- **Loop protection can suppress a legitimate repeat.** `wouldLoop` treats revisiting a target
  redirected to within the last 10 s in the same tab as a loop, e.g. back-and-forward onto the same
  Shorts URL. Judgement call in the current design; no change.
- **Popup + options writing `rules` concurrently** is last-write-wins on the whole array (stale
  overwrite possible if both pages save within the same tick). Not reproduced; low likelihood.
- **Sync join while another device's write is in flight** treats the partial snapshot as "no
  remote" and publishes local. Narrow race; not reproduced.
- **Tracking exceptions are global.** A ClearURLs exception for provider P (an `allow` rule) also
  suppresses the catch-all's cleanup on that URL, whereas ClearURLs scopes exceptions per provider.
  Pre-existing, documented in `dnr.ts`; unchanged.
- **Prerender navigations.** Checked that `frameId !== 0` already excludes prerendered outermost
  frames (they carry non-zero frame ids), so the fallback cannot navigate the visible tab on a
  speculative prerender. No issue.

## Deliberate differences from Redirector (documented, not changed)

- Wildcard patterns escape `|` (Redirector does not, so `a|b` is alternation there). Reroute's UI
  documents `*` as the only special character; kept.
- `urlDecode` uses `decodeURIComponent` (UTF-8 aware, throws on malformed input -> rule skipped)
  where Redirector uses the lenient `unescape`.
- `$10` and up: Reroute substitutes `$1..$9` only.

## Notes and suggestions (out of scope for this pass)

- `tabs` permission: `tabs.update(url)` and reading `tabs[0].url` under `<all_urls>` do not need it;
  it could be dropped. Permission changes need an explicit decision per AGENTS.md, so untouched.
- The `<all_urls>` content script exists only to write the clipboard for "Copy clean link".
  `chrome.scripting.executeScript` on demand (or the Offscreen API) would avoid injecting into every
  page; needs the `scripting` permission, so a product decision.
- Import "Choose file" wraps a `hidden` file input in a label; it is not reachable by keyboard.
- Rule editor does not `trim()` the include pattern; a trailing space becomes part of the pattern.
- The rule tester ignores the allowlist and the navigation-only filter the background applies.
- `RuleSetDocument.version` is not checked on import.
- The regenerated static ruleset is 578 KB pretty-printed (about 300 KB compact). Excluding
  `public/rules/*.json` from Prettier would keep the package smaller.
- Manifest and bundle checked: permissions exactly as in `wxt.config.ts`, `declarativeNetRequestFeedback`
  only in dev builds, static ruleset registered and enabled, no `web_accessible_resources`, no
  Lemon Squeezy secrets in the output (only public ids read from env at build time).

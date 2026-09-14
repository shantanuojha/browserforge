# Licensing review (branch `review/cookiesweep-licensing`)

Scope: every file under `packages/licensing/src` and `packages/ui/src` (the licence dialog and
the shared components both extensions use). The Lemon Squeezy behaviour below was checked against
the published License API docs and, where the docs were silent, against the production API with a
garbage key (no secrets involved; the interesting answers are the 404 / 422 shapes). Arbor and
Reroute were read to see how the client is used but were not modified.

Test counts: licensing 48 before, 56 after; ui 23 before, 28 after.

## Confirmed and fixed

### 1. High: a forced licence-server round-trip after every service-worker start (`e877d8b`)

- Cause: `scheduleRevalidation()` called `alarms.create(name, { periodInMinutes, delayInMinutes: 1 })`
  unconditionally. Both extensions call it at the top of `defineBackground`, i.e. on every worker
  start. Chrome replaces a same-named alarm on `create`, so every wake-up rescheduled the alarm to
  fire one minute later, and the handler runs `validate({ force: true })`. Net effect: a network
  call to `api.lemonsqueezy.com` (with the raw key) roughly once per worker lifecycle instead of
  once per 7 days, and, at 60 req/min per the docs, a realistic path into 429s (see 2).
- Evidence: `client.test.ts` "does not reset an alarm that already exists when the service worker
  restarts" (`create` called twice before the fix), "replaces an alarm whose period no longer
  matches", "still creates the alarm on a runtime without alarms.get()".
- Fix: `ensureAlarm()` checks `alarms.get(name)` first (the pattern Chrome's alarms docs
  recommend, since alarms may also be dropped on browser restart) and only creates when missing
  or when the period changed. The first fire is now one full period out; the cheap `validate()`
  on start already covers a stale cache. `AlarmsLike` gained an optional `get`; `chrome.alarms`
  still satisfies it (compile-time check in the test file).

### 2. High: a 429 / 422 / non-verdict JSON body turned a valid licence into `invalid` (`e877d8b`)

- Cause: `LicenseResponseSchema` has only optional fields, so any JSON object parses. Lemon
  Squeezy answers throttling with Laravel's `{ "message": "Too Many Attempts." }` and validation
  errors with `{ "message": ..., "errors": {...} }` (verified: a body without `license_key` gives
  HTTP 422 with exactly that shape). In `validate()` such a body reached
  `body.valid && status === "active"` as `undefined`, fell through to
  `save(invalidRecord(stored, "unknown"))`, and Pro switched off until the user pressed Restore
  purchase. In `activate()` the same bodies produced the unhelpful `unknown` error.
- Evidence: `client.test.ts` "treats a 429 rate-limit answer as transient", "treats a JSON body
  without a validate result as a bad response", "reports a 429 as a transient error the user can
  retry".
- Fix: `callLicenseApi()` maps 429 to `network` like 5xx, and returns `bad_response` for a parsed
  body that carries no `activated`/`valid`/`deactivated` boolean and no `error` string
  (`isLicenseVerdict`). Both are transport failures to `validate()`, which keeps the grace state.

### 3. Low: re-activating the key already on disk consumed a second activation seat (`e877d8b`)

- Cause: after "grace expired" (or any `invalid` state) the dialog shows the activation form; a
  user who pastes the same key again hit `/activate`, which creates a **new** instance and left
  the old one counting against `activation_limit`. With a limit of 1 the next device is refused.
- Evidence: `client.test.ts` "re-validates the existing instance instead of burning a seat for
  the same key" (calls were `activate, validate, activate`; now `activate, validate, validate`
  and the stored `instanceId` is unchanged), "falls back to a fresh activation when the stored
  instance is gone".
- Fix: `activate()` first validates the stored instance when the normalised key matches; only if
  that instance is gone or the key is no longer valid does it perform a fresh activation.

### 4. Medium (UI): the dialog declared itself modal but did not manage focus (`4e77c27`)

- Cause: `ActivateLicenseDialog` had `role="dialog" aria-modal="true"` and an `onKeyDown` for
  Escape on the container, but nothing moved focus into it. In the Pro state nothing autofocuses,
  so the opener button kept focus, Escape never reached the handler and Tab walked the page
  behind the backdrop; in the form state Tab could leave the dialog.
- Evidence: `components.test.tsx` "can take focus itself so keyboard handling works" (container
  had no `tabindex`), plus unit tests for the wrap rules in "focus trap".
- Fix: container is focusable (`tabIndex={-1}`); on open focus moves to the first tabbable control
  unless something inside already has it; Tab / Shift+Tab wrap at the edges; focus returns to the
  opener on close. The wrap decision is a pure function (`focusTrap.ts`, `nextFocusTarget`) so it
  is tested without a DOM environment (the repo has none; adding jsdom is not allowed here).

## Verified correct (no change)

- **Request encoding.** README said form-encoded, code sends JSON. Checked against production:
  a JSON body yields `{"valid":false,"error":"license_key not found."}` (404), the same as the
  form-encoded request; an unparsed body would have produced the 422 above. JSON is accepted;
  README corrected rather than the code.
- Endpoints, `Accept: application/json`, response shapes (`activated`/`valid`/`deactivated`,
  `error`, `license_key.status` in `inactive|active|expired|disabled`, `instance.id`,
  `meta.variant_id`, `customer_email`) match the docs; `expires_at` is parsed to epoch ms.
- Activation limit: LS returns HTTP 400 with `"This license key has reached the activation
limit."`; `classifyApiError` maps it before the generic "not found / invalid" rule.
- Wrong variant on activate releases the seat with a `deactivate` call before reporting
  `wrong_product`; on validate it becomes `invalid(wrong_product)`.
- Grace math: `graceEndsAt = lastValidatedAt + gracePeriodMs`, evaluated at read time, so a
  backward clock jump extends grace rather than revoking Pro; a forward jump shortens it. While
  `lastFailedAt` is set every `validate()` retries, so recovery is immediate once online.
- Deactivate: 5xx / network keeps the licence; "already gone on the server" is treated as success
  and the raw key is removed from storage.
- The raw key is stored (needed for validate) but never present in any `LicenseState`
  (`maskKey`), and `instance_name` carries only a coarse browser family plus a random suffix.
- `configured: false` paths in Arbor/Reroute return `undefined` clients and skip scheduling.

## Unconfirmed (reasoning only, no code change)

- **Entitlement staleness across contexts.** `defineFeatures().init(client)` subscribes to
  `client.onChange`, which only fires for changes made through that same client instance. A
  demotion performed by the background's alarm is not seen by an already-open side panel or
  options page until it re-reads. Popups are short-lived so this is mostly theoretical for the
  side panel. A fix needs `storage.onChanged` plumbing in `LicenseStorage`, which touches the
  extensions' call sites (out of scope); noting for the integrator.
- **`useLicense` initial `null` state renders the activation form for a moment** for Pro users
  until `getState()` resolves from storage (one read, typically < 10 ms). Cosmetic.
- **`classifyApiError` string matching.** The mapping relies on the English wording of LS error
  strings (`not found`, `activation limit`, `expired`, `disabled`, `instance`). The observed
  strings match today; a wording change would degrade to `unknown`, which is handled (the licence
  becomes `invalid(unknown)` with a Restore purchase path). `license_key.status` is checked
  first where it exists, which is the stable signal.
- **`browserFamily` cannot detect Brave** (Brave does not expose itself in the UA); such
  instances are labelled `chrome`. Harmless.

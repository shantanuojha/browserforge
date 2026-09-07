# @browserforge/licensing

Lemon Squeezy licence-key client shared by every paid BrowserForge extension. Pure TypeScript,
no UI; the activation dialog lives in `@browserforge/ui`.

## Specification

Lemon Squeezy License API (no auth header needed for these three endpoints, they are meant to be
called from client software):

- `POST https://api.lemonsqueezy.com/v1/licenses/activate` body `license_key`, `instance_name`
- `POST https://api.lemonsqueezy.com/v1/licenses/validate` body `license_key`, `instance_id`
- `POST https://api.lemonsqueezy.com/v1/licenses/deactivate` body `license_key`, `instance_id`

All are `application/x-www-form-urlencoded` (JSON also accepted) and return JSON with
`activated`/`valid`, `error`, `license_key { status, activation_limit, activation_usage, expires_at }`,
`instance { id, name }`, `meta { store_id, product_id, variant_id, customer_email, ... }`.

### Public API

```ts
createLicenseClient({
  productName: "arbor",                      // storage namespace
  allowedVariantIds: [12345],                // reject keys bought for another product
  storage: chrome.storage.local,             // injectable for tests
  fetch: globalThis.fetch,                   // injectable for tests
  now: () => Date.now(),
  gracePeriodMs: 14 * 24 * 3600 * 1000,      // offline grace after last successful validation
  revalidateEveryMs: 7 * 24 * 3600 * 1000,
})
  .activate(key: string): Promise<Result<LicenseState, LicenseError>>
  .validate(opts?: { force?: boolean }): Promise<LicenseState>
  .deactivate(): Promise<Result<void, LicenseError>>
  .getState(): Promise<LicenseState>
  .isPro(): Promise<boolean>
  .onChange(cb): () => void
```

`LicenseState` is a discriminated union: `{ kind: "free" }`, `{ kind: "pro", key(masked), instanceId,
lastValidatedAt, expiresAt?, email? }`, `{ kind: "grace", ...pro, graceEndsAt }`,
`{ kind: "invalid", reason }`.

### Rules

- Never store the raw key in plain text more than necessary: store it (it is needed for
  `validate`), but always expose it masked (`XXXX-…-1234`) to UI.
- `instance_name` = `${productName}@${browserLabel}` where browserLabel is derived from
  `navigator.userAgent` family + a random 6-char suffix persisted in storage, so one licence can be
  activated on N profiles up to `activation_limit`.
- `validate()` is cheap-by-default: returns cached state unless `revalidateEveryMs` elapsed or
  `force`. Network failure inside grace keeps `pro` behaviour (`kind: "grace"`); past grace it
  degrades to `free` and surfaces a reason.
- Map Lemon Squeezy statuses: `active` → pro; `expired`/`disabled` → invalid; wrong `variant_id` →
  invalid("wrong_product").
- No telemetry, no other network calls. The only endpoint touched is `api.lemonsqueezy.com`.
- Feature gates: `defineFeatures({ backups: "pro", drive: "pro", tree: "free" })` returns a typed
  `can(feature)` helper that reads the cached state synchronously after `init()`.
- Background usage: expose `scheduleRevalidation(alarms)` that registers a `chrome.alarms` alarm
  named `${productName}:license-revalidate` and a handler.

### Tests (vitest, node env)

Mock `fetch` for: activation success, activation limit reached, invalid key, wrong variant,
validate success, validate expired, network error inside grace, network error after grace,
deactivate. Use an in-memory storage shim (or `@webext-core/fake-browser`).

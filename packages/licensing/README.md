# @browserforge/licensing

Licence-key client shared by every paid BrowserForge extension, with one adapter per provider
(Polar, Lemon Squeezy). Pure TypeScript, no UI; the activation dialog lives in `@browserforge/ui`.

## Specification

### Providers

The client (`client.ts`) is provider-agnostic: it talks to a `LicenseApi` port and every adapter
answers with the same normalised verdict (`LicenseResponse` in `api-schema.ts`: `activated` /
`valid` / `deactivated`, `error`, `error_code`, `license_key.status`, `instance.id`, `meta`). The
verdict's field names are inherited from the first provider; `meta.product_ref` and `error_code`
were added so a second provider does not have to imitate Lemon Squeezy's wording.

```ts
createLicenseClient({
  productName: "arbor",                      // storage namespace + first half of the instance label
  provider: "polar",                         // "lemonsqueezy" (default) | "polar"
  allowedProductRefs: [benefitId],           // Polar benefit ids, or LS variant ids as strings
  polar: { organizationId, benefitId, baseUrl }, // Polar only; baseUrl defaults to api.polar.sh
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

Extensions do not assemble these options by hand: `readProviderConfig(env, licensingEnvNames(SUFFIX),
fallbackUrl)` (`provider-config.ts`) reads `WXT_LICENSE_PROVIDER`, the Polar and Lemon Squeezy ids,
checkout URL, organisation slug and API base from `import.meta.env`, infers the provider when the
variable is unset (Polar if both Polar ids parse, else Lemon Squeezy), and `providerClientOptions()`
turns the result into `provider` / `polar` / `allowedProductRefs`. It also yields the provider's URLs
for the UI: `checkoutUrl` and `restoreUrl` (Polar: `https://polar.sh/<slug>/portal`, or the sandbox
portal when the API base is `sandbox-api.polar.sh`).

#### Polar (`polar-api.ts`, `createPolarLicenseApi`)

Public customer-portal endpoints, no token, CORS-open (`Access-Control-Allow-Origin: *`), so the
extension calls them directly and needs no host permission. Base `https://api.polar.sh`
(`POLAR_API`) or `https://sandbox-api.polar.sh` (`POLAR_SANDBOX_API`); `organization_id` is
required in every body and is public. Docs: <https://polar.sh/docs/api-reference/customer-portal/license-keys/activate>,
`.../validate`, `.../deactivate`; failure phrases come from Polar's server
(`server/polar/license_key/service.py`).

| Port call                                  | Polar request                                                                      | Polar answer → normalised verdict                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activate({ license_key, instance_name })` | `POST /v1/customer-portal/license-keys/activate` `{ key, organization_id, label }` | 200 `LicenseKeyActivationRead` → `activated: true`, `instance: { id, name: label }`, `license_key.status` (`granted` → `active`), `meta.product_ref = license_key.benefit_id`. 403 `NotPermitted` → `activated: false` with `error_code`: "activation limit" → `activation_limit`, "no longer active" → `disabled`, "expired" → `expired`; "does not support activations" (benefit without an activation limit) → `bad_response` error, never a rejection. 404 → `invalid_key`. |
| `validate({ license_key, instance_id })`   | `POST .../validate` `{ key, organization_id, activation_id, benefit_id? }`         | 200 `ValidatedLicenseKey` → `valid: true`, `instance` from `activation`, `meta.product_ref = benefit_id`. 404 `ResourceNotFound` → `valid: false` with `error_code`: "no longer active" → `disabled`, "expired" → `expired`, "does not match given benefit" → `wrong_product`, "Not found" (key or activation gone) → `not_activated`, anything else → `unknown`.                                                                                                               |
| `deactivate({ license_key, instance_id })` | `POST .../deactivate` `{ key, organization_id, activation_id }`                    | 204 (no body) → `deactivated: true`. 404 → `deactivated: false`, `error_code: not_activated`, which the client already counts as "already gone".                                                                                                                                                                                                                                                                                                                                |
| any                                        |                                                                                    | 429 (`Retry-After`; 3 req/s per IP) and 5xx → `network`; 422 and unparsable bodies → `bad_response`. Neither demotes a stored licence.                                                                                                                                                                                                                                                                                                                                          |

`benefit_id` on `validate` makes Polar reject a key bought for another product server-side;
`activate` has no such input, so the client compares `meta.product_ref` with `allowedProductRefs`
after activation and releases the seat on mismatch (`wrong_product`). Polar key statuses are
`granted | revoked | disabled`; `revoked` (refund, manual pull) reads as `invalid(disabled)`.

#### Lemon Squeezy (`api.ts`, `createLicenseApi`)

License API (no auth header needed for these three endpoints, they are meant to be called from
client software):

- `POST https://api.lemonsqueezy.com/v1/licenses/activate` body `license_key`, `instance_name`
- `POST https://api.lemonsqueezy.com/v1/licenses/validate` body `license_key`, `instance_id`
- `POST https://api.lemonsqueezy.com/v1/licenses/deactivate` body `license_key`, `instance_id`

The docs recommend `application/x-www-form-urlencoded`; the API also parses `application/json`
(verified against production: a JSON body yields `license_key not found.`, not a 422), which is what
this client sends. Responses are JSON with `activated`/`valid`/`deactivated`, `error`,
`license_key { status, activation_limit, activation_usage, expires_at }`, `instance { id, name }`,
`meta { store_id, product_id, variant_id, customer_email, ... }`, i.e. the verdict shape verbatim.
Validation failures (422) and rate limiting (429, 60 req/min) come back as Laravel `{ message,
errors? }` bodies with none of those keys; the client treats them as transport problems, never as a
licence rejection.

### Stored record

`license-record.ts` persists `{ v: 2, kind: "activated" | "invalid" | "free", provider, ... }` under
`${productName}:license`. v1 records (written before the provider switch) are read as Lemon Squeezy
records. A record whose `provider` differs from the client's reads as `invalid(unknown)` with the
masked key, without a network call: the dialog shows "Restore purchase", the user pastes the same
key and `activate()` runs against the current provider; `deactivate()` on such a record only drops
it locally.

### Rules

- Never store the raw key in plain text more than necessary: store it (it is needed for
  `validate`), but always expose it masked (`XXXX-…-1234`) to UI.
- The instance label is `${productName}@${browserLabel}` where browserLabel is derived from
  `navigator.userAgent` family + a random 6-char suffix persisted in storage, so one licence can be
  activated on N profiles up to the activation limit. It is Lemon Squeezy's `instance_name` and
  Polar's `label`.
- `validate()` is cheap-by-default: returns cached state unless `revalidateEveryMs` elapsed or
  `force`. Network failure inside grace keeps `pro` behaviour (`kind: "grace"`); past grace it
  degrades to `free` and surfaces a reason.
- Map statuses: `active` → pro; `expired`/`disabled`/`revoked` → invalid; wrong product
  (`meta.product_ref`, or `String(meta.variant_id)` for Lemon Squeezy) → invalid("wrong_product").
- No telemetry, no other network calls. The only endpoint touched is the configured provider's
  licence API: `api.polar.sh` (or `sandbox-api.polar.sh` in sandbox builds) or
  `api.lemonsqueezy.com`.
- Feature gates: `defineFeatures({ backups: "pro", drive: "pro", tree: "free" })` returns a typed
  `can(feature)` helper that reads the cached state synchronously after `init()`.
- Background usage: expose `scheduleRevalidation(alarms)` that registers a `chrome.alarms` alarm
  named `${productName}:license-revalidate` and a handler. It runs on every service-worker start,
  so it must only create the alarm when `alarms.get()` says it is missing or has a stale period;
  re-creating it would reschedule the first fire and force a network check after every wake-up.
- `activate(key)` with the key that is already stored re-validates the existing instance first and
  only performs a fresh activation (a new seat) when that instance is gone.

### Tests (vitest, node env)

`client.test.ts` drives the state machine through the Lemon Squeezy adapter, `client-polar.test.ts`
through the Polar adapter (activate → pro, revoked → invalid, wrong benefit → seat released, offline
grace, 429 kept as grace, v1 record → Restore purchase → re-activation on Polar). `polar-api.test.ts`
covers the mapping table above against JSON fixtures in `src/fixtures/polar/` (written from Polar's
OpenAPI schemas and server phrases; sources cited in `test-utils.ts`). Test doubles
(`createMemoryStorage`, `createFakeFetch`, the body builders and `polarFixtures`) are exported from
`@browserforge/licensing/testing`.

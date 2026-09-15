# BrowserForge

Open-source Manifest V3 browser extensions, built to replace tools that died with Manifest V2.

| Extension                             | What it does                                                               | Status         |
| ------------------------------------- | -------------------------------------------------------------------------- | -------------- |
| [Arbor](extensions/arbor)             | Tree-style tab and session manager that never loses your tabs              | in development |
| [Reroute](extensions/reroute)         | URL rewrite rules: redirects, regex transforms, tracking-parameter cleanup | in development |
| [CookieSweep](extensions/cookiesweep) | Auto-delete cookies and site data when you leave a site                    | in development |

Principles: no telemetry, no remote code, minimal permissions, MIT licensed. Paid "Pro" tiers unlock
convenience features; the core of every extension is free.

## Development

```sh
pnpm install
pnpm dev:arbor          # or dev:reroute / dev:cookiesweep — opens Chrome with the extension loaded
pnpm test               # all vitest projects
pnpm typecheck && pnpm lint
pnpm build              # every extension -> extensions/*/.output/chrome-mv3
```

Requirements: Node 22+, pnpm 10. See [AGENTS.md](AGENTS.md) for conventions and store-policy rules.

Commits must be authored and committed as `shantanu ojha <shantanu.ojha49@gmail.com>` (no `Co-authored-by` trailers for tools or agents).

## Releasing

1. `pnpm changeset` → `pnpm version-packages` → commit.
2. Push a tag `arbor@1.2.3` (name must match the `extensions/<name>` directory).
3. `.github/workflows/release.yml` zips and submits via [WXT](https://wxt.dev) `wxt submit`
   (Chrome Web Store API V2 with a service account; Edge and Firefox optional).

The first upload of each extension is manual in the Chrome Web Store Developer Dashboard; the API
can only update existing items.

## Layout

```
extensions/    arbor, reroute, cookiesweep   (WXT + React)
packages/      shared, licensing, ui         (workspace libraries)
```

The website lives in its own repository, `browserforge-site`: landing page
[shantanuojha.com](https://shantanuojha.com), product pages at `https://<name>.shantanuojha.com`
(e.g. [arbor.shantanuojha.com](https://arbor.shantanuojha.com)), privacy policies at
`https://<name>.shantanuojha.com/privacy`, support via hello@shantanuojha.com.

## Licensing

Arbor and Reroute read their licence-provider configuration from `WXT_*` variables in
`extensions/<name>/.env` (git-ignored; see each `.env.example`). The provider is Polar or, while
that adapter is kept, Lemon Squeezy (`WXT_LICENSE_PROVIDER`, inferred from the ids present when
unset). Generate both files from the local secrets file (`C:\Users\SHANTANU\.browserforge\secrets.env`,
keys `LICENSE_PROVIDER`, `POLAR_ORGANIZATION_ID`, `POLAR_BENEFIT_ID_ARBOR`, `POLAR_BENEFIT_ID_REROUTE`,
`POLAR_CHECKOUT_URL_ARBOR`, `POLAR_CHECKOUT_URL_REROUTE`, `POLAR_ORG_SLUG`, their `POLAR_SANDBOX_*`
mirrors, and the legacy `LEMONSQUEEZY_*` ids) with:

```powershell
pwsh scripts/write-env.ps1                       # or: -SecretsPath <file>
pwsh scripts/write-env.ps1 -Sandbox              # POLAR_SANDBOX_* ids + sandbox-api.polar.sh
```

The script skips empty keys, never forwards `POLAR_OAT*` tokens, sets
`WXT_LEMONSQUEEZY_CHECKOUT_URL_*` to the product pages' `#pro` anchors, and never prints values.
Without a `.env`, builds still work: Pro gates stay closed and the options page shows "Licensing
not configured".

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
`https://shantanuojha.com/privacy/<name>`, support via hello@shantanuojha.com.

## Licensing

Arbor and Reroute read their Lemon Squeezy configuration from `WXT_*` variables in
`extensions/<name>/.env` (git-ignored; see each `.env.example`). Generate both files from the local
secrets file (`C:\Users\SHANTANU\.browserforge\secrets.env`, keys `LEMONSQUEEZY_STORE_ID`,
`LEMONSQUEEZY_VARIANT_ID_ARBOR`, `LEMONSQUEEZY_VARIANT_ID_REROUTE`) with:

```powershell
pwsh scripts/write-env.ps1                       # or: -SecretsPath <file>
```

The script skips empty keys, sets `WXT_LEMONSQUEEZY_CHECKOUT_URL_*` to the product pages'
`#pro` anchors, and never prints values. Without a `.env`, builds still work: Pro gates stay closed
and the options page shows "Licensing not configured".

# Working in this repository

Read this before changing anything. It applies to humans and to AI agents working in parallel.

## Layout

- `packages/shared` — pure TS utilities (no DOM, no `chrome.*` at import time).
- `packages/licensing` — Lemon Squeezy licence client. Spec in its README.
- `packages/ui` — shared React components + `styles.css` tokens. Spec in its README.
- `extensions/arbor`, `extensions/reroute`, `extensions/cookiesweep` — WXT extensions. Each README is
  the product spec for that extension.
- The website is a separate repository (`browserforge-site`); nothing site-related lives here.

## Rules for parallel work

1. Stay inside the package you were assigned. Touching another package (including `packages/*`)
   requires saying so explicitly in your final report; prefer proposing the change instead.
2. Do not run `git` commands (commit, branch, stash). The integrator commits.
3. Do not add npm dependencies. Everything needed is already installed at the root. If you truly
   need a library, list it in your final report with a one-line justification; do not run `pnpm add`
   (concurrent installs corrupt the lockfile).
4. Never commit or print secrets. Local secrets live outside the repo in
   `C:\Users\SHANTANU\.browserforge\secrets.env`; CI secrets live in GitHub.
5. Verify before reporting: `pnpm --filter <pkg> typecheck`, `pnpm --filter <pkg> test`, and for
   extensions `pnpm --filter <pkg> build`.

## Code conventions

- TypeScript strict, ESM, explicit imports (WXT auto-imports are disabled). Import WXT helpers from
  `wxt/utils/define-background`, `wxt/browser`, `wxt/utils/storage`, etc.
- React 19 function components, plain CSS using the tokens in `@browserforge/ui/styles.css`.
  No CSS-in-JS, no Tailwind, no gradients, no emojis in UI text.
- Tests: vitest, colocated `*.test.ts`. Pure logic lives in `src/lib/` so it can be tested without a
  browser; use `@webext-core/fake-browser` when you must touch `browser.*`.
- Cross-browser: use `browser` from `wxt/browser`, feature-detect Chrome-only APIs (`sidePanel`).

## Chrome Web Store policy (non-negotiable)

- No remote code: no `eval`, no `new Function`, no `<script src>` to another origin, no fetching
  logic/config that changes behaviour. Data files may be bundled; catalogs are compiled at build time.
- Single purpose per extension. Permissions exactly as declared in `wxt.config.ts`; ask before adding.
- No analytics or telemetry. The only network calls allowed are to `api.lemonsqueezy.com` (licensing)
  and, for Arbor's opt-in Drive backup, Google APIs.
- Never reuse the name, icon or branding of the extensions we replace (Tabs Outliner, Redirector,
  ClearURLs, Cookie AutoDelete). Mentioning them in "imports from" text is fine.

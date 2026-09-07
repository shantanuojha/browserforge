# BrowserForge site

Plain static HTML/CSS in `public/`. No build step, no JavaScript, no third-party assets, so the
privacy policy pages can truthfully say the site does not track visitors.

Deployed to Vercel (project root: `site`, output directory: `public`, framework: Other) and mirrored
to GitHub Pages by `.github/workflows/pages.yml`.

## Pages to write (Phase 6)

- `/arbor`, `/reroute`, `/cookiesweep` — one page each: what it does, screenshots, free vs Pro table,
  install buttons (Chrome Web Store, Edge Add-ons, Firefox), link to source.
- `/privacy` — umbrella privacy policy plus a section per extension listing exactly which data is
  processed and where (all local; licence check to `api.lemonsqueezy.com` for paid extensions).
  Must include the Chrome Web Store Limited Use statement for any extension touching Google APIs
  (Arbor's Drive backup).
- `/terms` — licence terms for Pro purchases (one-time, per person, activation limit, refunds via
  Lemon Squeezy).
- `/support` — email and GitHub issues link.

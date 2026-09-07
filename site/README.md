# BrowserForge site

Plain static HTML/CSS in `public/`. No build step, no JavaScript, no third-party assets, so the
privacy policy pages can truthfully say the site does not track visitors.

## Pages

| Path           | File                            | Purpose                                                                                  |
| -------------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| `/`            | `public/index.html`             | Landing page                                                                             |
| `/arbor`       | `public/arbor/index.html`       | Product page: features, Free vs Pro, import, permissions                                 |
| `/reroute`     | `public/reroute/index.html`     | Product page                                                                             |
| `/cookiesweep` | `public/cookiesweep/index.html` | Product page (no Pro tier)                                                               |
| `/privacy`     | `public/privacy/index.html`     | Umbrella privacy policy; `#arbor`, `#reroute`, `#cookiesweep` anchors for store listings |
| `/terms`       | `public/terms/index.html`       | Pro licence terms                                                                        |
| `/support`     | `public/support/index.html`     | Email, GitHub issues, FAQ                                                                |
| `/404.html`    | `public/404.html`               | Not-found page (picked up automatically by both hosts)                                   |
| `/robots.txt`  | `public/robots.txt`             |                                                                                          |
| `/sitemap.xml` | `public/sitemap.xml`            |                                                                                          |

Every page is a directory with an `index.html` so that extension-less links such as `/arbor`
resolve on both Vercel (`cleanUrls`) and GitHub Pages (which does not strip `.html`).

Install buttons on the product pages point at `#` and carry a `data-store="chrome|edge|firefox"`
attribute. Replace the `href` with the store listing URL once each listing is approved.

## Domain

`https://browserforge.dev` is used in canonical links, `robots.txt` and `sitemap.xml` as a
**placeholder**. The domain is not yet registered. Replace it everywhere (search for
`browserforge.dev`) if a different domain is chosen; the `support@browserforge.dev` address is
used in the privacy policy, terms and support page as well.

## Vercel setup checklist

1. Import the GitHub repository into Vercel.
2. **Root Directory:** `site`
3. **Framework Preset:** Other
4. **Build Command:** leave empty (no build step)
5. **Output Directory:** `public`
6. **Install Command:** leave empty / disable
7. `vercel.json` in this folder already sets `cleanUrls: true`, `trailingSlash: false` and the
   security headers (nosniff, referrer policy, a CSP that allows only same-origin styles).
8. Add the custom domain and point DNS at Vercel.

## GitHub Pages mirror

`.github/workflows/pages.yml` uploads `site/public` to GitHub Pages on every push to `main` that
touches it.

Caveat: all links and the stylesheet reference are root-relative (`/styles.css`, `/arbor`). That
is correct for Vercel and for GitHub Pages **with a custom domain**. On the default project URL
(`https://shantanuojha.github.io/browserforge/`) the site lives under `/browserforge/`, so
root-relative links would break. Either attach the custom domain to the Pages site (a `CNAME`
file in `public/` is then needed) or, if the mirror must work at the project path, add a
`<base href="/browserforge/">` to each page and switch links to relative paths. Each HTML file
carries a comment noting this assumption.

GitHub Pages redirects `/arbor` to `/arbor/` (301) and serves the directory index; Vercel serves
`/arbor` directly and redirects `/arbor/` to `/arbor`. Both are fine for the links used here.

## Editing

- Keep pages free of JavaScript, external fonts, images from other origins and analytics; the
  privacy policy states there are none and the CSP in `vercel.json` would block them anyway.
- No emojis, no gradients. Dark mode comes from `prefers-color-scheme` in `styles.css`.
- Run `pnpm format` from the repo root before handing off; Prettier formats HTML and CSS.
- Product facts (permissions, prices, features) must match each extension's `wxt.config.ts` and
  README. When a permission changes, update the product page's Permissions list and the privacy
  policy in the same change.

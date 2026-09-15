# Reroute changelog

User-facing changes per Chrome Web Store release. Dates are release dates.

## Unreleased

### Changed

- **Pro purchases move to Polar.** Reroute Pro licence keys are now issued and checked through
  Polar (polar.sh), which handles checkout, invoices and refunds as the merchant of record. The
  extension's only network call becomes the licence check against `api.polar.sh`; nothing else
  about what Reroute sends or stores changes, and no permissions change. "Buy Pro" opens the Polar
  checkout and "Restore purchase" opens the Polar customer portal, where you can also free a seat
  you no longer use. A key activated with the previous provider shows as "not valid" once; paste
  the same key again to activate it here.

## 0.1.1 — 2026-09-15

### Fixed

- **Pro sync no longer overwrites rules from your other devices.** Turning sync on used to push
  this device's rule list (empty on a fresh install) to every other signed-in browser. It now
  reads the synced set first and merges it with the local rules, keeping both.
- **Tracking cleaner removes site-specific parameters reliably.** Parameters such as YouTube's
  `si` were stripped by "Copy clean link" but not on the actual navigation, because the
  general-purpose rule shadowed the site rule at the network layer. Site rules now take
  precedence and include the general parameters, so the link you land on matches the cleaned one.
- **Wildcard matching behaves like Redirector.** `*` now matches as little as possible, so
  imported rules with several wildcards and `$1`, `$2`, ... in the target split the URL the same
  way Redirector did.
- **Regex rules with top-level alternation** (`^a|b$`) are anchored correctly at the network layer
  instead of rewriting only part of the URL.
- **Per-site allowlist is exact.** `example.com` covers only that host, `*.example.com` only its
  subdomains, and `*example.com` both, as the Allowlist page describes. The network rules
  previously treated every entry as host plus subdomains.
- **Redirector import fidelity.** `doubleUrlDecode` transforms, `base64decode` on URL-encoded
  captures and the pre-3.0 `unescapeMatches` / `escapeMatches` flags are now imported correctly
  instead of being dropped or silently failing to fire.
- **Re-importing your own export in "Add" mode** no longer creates duplicate rule ids; colliding
  rules get fresh ids so toggling, editing and deleting act on one rule only.
- **"Clear log"** in the options page is no longer undone by the next redirect.
- **`javascript:` targets are rejected** in the rule editor and tester, since the browser never
  allows an extension to navigate to them.
- **Pro sync switch** can always be turned off, including after a licence lapses.
- Status page counts only user redirect rules as network rules, and regexes using RE2-only
  escapes (`\A`, `\z`, `\Q...\E`) fall back to the in-page engine instead of matching differently.

## 0.1.0 — 2026-09-08

First Chrome Web Store release: wildcard and regex redirect rules with `$1`-style captures and
transforms, network-layer redirects with an in-page fallback for rules the network engine cannot
express, a tracking-parameter cleaner built from the ClearURLs catalog, "Copy clean link", a
per-site allowlist, rule tester, activity log, JSON export/import, Redirector import, and an
optional Pro licence (rule sync across devices, curated rule packs, shareable rule-set links).

# @browserforge/ui

Shared React 19 components used by every extension's popup, options and side panel. Plain CSS with
the tokens in `src/styles.css` (no CSS-in-JS, no Tailwind, no gradients, no emojis).

## Components to implement (Phase 2)

- `Button`, `IconButton`, `Toggle`, `TextInput`, `Select`, `Badge`, `Callout`, `EmptyState`,
  `Section` (title + description + children) and `KeyValueList` — small, accessible, keyboard-first.
- `ProBadge` — tiny "Pro" label.
- `ProGate` — wraps a feature; renders children when `can(feature)` is true, otherwise a compact
  upsell row with the price and an "Unlock" button that opens the hosted Lemon Squeezy checkout in a
  new tab (URL passed by the extension; never embed remote scripts).
- `ActivateLicenseDialog` — paste key → `activate()` → success/failure states, masked key display,
  "Deactivate this browser" and "Restore purchase" actions. Uses `@browserforge/licensing`.
- `useLicense()` hook — subscribes to `onChange` and exposes `{ state, isPro, refresh }`.

Export everything from `src/index.ts`. Components must work inside a 360px-wide popup and in a full
options page. Unit-test pure logic (e.g. key masking helpers) with vitest; component rendering
tests are optional in Phase 2.

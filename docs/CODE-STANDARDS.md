# Code standards

The short version of Clean Code and SOLID as this repository applies them. `eslint.config.js`
enforces the measurable parts; `docs/ARCHITECTURE.md` explains the layers these rules protect.

## Enforced by ESLint

Thresholds are what the refactored packages (`extensions/reroute`, `extensions/cookiesweep`,
`packages/*`) meet today. Tighten them when the code allows; never loosen them for one file. Arbor
runs the same rules as warnings until its own refactor lands, then flips to errors by changing one
word in `eslint.config.js`.

| Rule                                                | Limit                          | Applies to                                                      |
| --------------------------------------------------- | ------------------------------ | --------------------------------------------------------------- |
| `complexity`                                        | 12                             | every `.ts`/`.tsx`, tests included                              |
| `max-depth`                                         | 3 nested blocks                | every `.ts`/`.tsx`                                              |
| `max-params`                                        | 4 (5 in test builders)         | every `.ts`/`.tsx`                                              |
| `max-lines-per-function`                            | 65 lines (`.ts`), 120 (`.tsx`) | production code; tests exempt                                   |
| `max-lines`                                         | 300 lines per file             | production code; tests exempt                                   |
| `no-nested-ternary`                                 | none                           | everywhere                                                      |
| `no-console`                                        | none                           | everywhere except `shared/logger.ts` and `scripts/`             |
| `@typescript-eslint/explicit-module-boundary-types` | exported functions typed       | `packages/shared`, `packages/licensing`, `extensions/*/src/lib` |
| `@typescript-eslint/consistent-type-imports`        | `import type`                  | everywhere                                                      |
| `no-eval`, `no-implied-eval`, `no-new-func`         | none                           | everywhere (Chrome Web Store policy)                            |

Lines are counted without blanks and comments. A function that needs more than 65 lines is doing
more than one thing: extract the second thing. A component over 120 lines has a sub-component
hiding in its JSX or a hook hiding in its state.

## Functions

- One level of abstraction per function. A function that orchestrates (`runCleanup`) does not also
  parse URLs; it calls something that does.
- Prefer objects over positional argument lists once you reach four (`planStore(snapshot, lists,
options)`, `cleanDomainsInStore(api, target, options)`).
- No boolean flag arguments that switch behaviour; pass an options object with named fields or
  split the function.
- No side effects in getters or predicates. `isPro()` reads; `setupLicensing()` creates.
- Verbs for functions (`deploy`, `record`, `schedule`), nouns for values (`deployment`, `plan`).

## Dependencies and boundaries

- Domain code (`src/lib/**`) imports nothing from `wxt/*` or `browser.*` and never calls
  `Date.now()`; it takes a `Clock`. See the layer table in `docs/ARCHITECTURE.md`.
- Every browser API the background uses sits behind a port declared by the service that needs it.
  Adapters implement ports and are the only place that API appears.
- Tests use in-memory ports. Reach for `@webext-core/fake-browser` only when testing an adapter or
  the wiring itself.
- Test doubles live once (`@browserforge/licensing/testing`, `lib/background/testing.ts`); do not
  copy a fake storage into a fourth test file.

## Errors

- Domain functions that can fail for a _caller's_ reason return a `Result`/`Validation`
  (`parseRule`, `LicenseResult`). They throw only for programmer errors.
- Adapters wrap browser failures: a rejected `tabs.update` becomes a recorded activity entry, a
  missing `storage.session` becomes the memory fallback.
- No empty `catch {}`. Either handle it with a comment that says why it is safe to ignore, or log it
  through the scoped logger (`createLogger("reroute:activity").warn(...)`).
- Build messages with `errorMessage(error)` from `@browserforge/shared`; never
  `error instanceof Error ? error.message : String(error)` inline.

## Naming

- Use the vocabulary table in `docs/ARCHITECTURE.md`. One word per concept, per product.
- No encodings or abbreviations in identifiers (`pattern`, not `pat`; `snapshot`, not `snap`).
  Loop indices and one-letter lambda parameters over obvious collections are fine.
- File names describe the concept, not the pattern: `rule-deployer.ts`, not `DnrManager.ts`.

## Comments

- Comments explain _why_: a browser quirk, a policy, an ordering constraint. What the code does is
  said by the code.
- No commented-out code. No `TODO` without an issue link.
- Module header comments state the module's single responsibility and what it deliberately does
  not do.

## Tests

- F.I.R.S.T.: fast (no timers unless faked), independent (fresh fixture per test), repeatable
  (injected clock and random ids), self-validating, timely.
- One concept per test; the name says the rule being demonstrated
  (`"join adopts a remote set merged with local rules"`).
- Fixtures and builders remove duplication (`activatedBody()`, `createFakeDnr()`); assertions stay
  explicit.
- Prefer behaviour tests through the public surface. Test a private helper only when no behaviour
  test can reach the rule.

## Before you commit

```
pnpm format && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

All six must be green. `pnpm lint` reports 0 errors; warnings are Arbor's queue, not a licence to
add more.

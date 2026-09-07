# Changesets

Every user-visible change to an extension gets a changeset:

```sh
pnpm changeset
```

`pnpm version-packages` bumps each affected `package.json`; WXT copies that version into the
manifest at build time. The Chrome Web Store rejects uploads whose version is not strictly greater
than the last one, so never re-tag the same version.

Release a single extension by pushing a tag of the form `<name>@<version>`, e.g. `arbor@1.0.1`.
See `.github/workflows/release.yml`.

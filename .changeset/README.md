# Changesets

This folder holds [Changesets](https://github.com/changesets/changesets) — the
semver source of truth for the public `@uptimizr/*` packages.

## Adding a changeset

When you make a change that should be released, run:

```bash
pnpm changeset
```

Pick the affected packages and the bump type (`patch` / `minor` / `major`), and
write a short summary. This creates a markdown file in `.changeset/` that you
commit alongside your change.

## Releasing

Releases are **manual and semver-oriented** (see
`.github/workflows/release.yml`). The release workflow runs `changeset version`
(bumps versions + writes CHANGELOGs) and then `changeset publish` (publishes only
the packages whose version advanced, with npm provenance). It defaults to a dry
run.

Private packages (`"private": true`) and the apps/sites are never published.

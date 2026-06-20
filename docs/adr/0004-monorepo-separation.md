# ADR 0004: Self-contained OSS monorepo

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** Project owner, engineering

## Context

The open-source data-collector (Apache-2.0) is developed as a pnpm + Turborepo monorepo. We want
the collector to stay self-contained and independently extractable, with a clear licensing story
and no accidental coupling to anything outside the open-source tree.

## Decision

- The open-source code lives under **`oss/`** (`oss/apps/*`, `oss/packages/*`); examples live
  under `examples/`; infrastructure and docs under `infra/` and `docs/`.
- **The OSS tree is self-contained:** `oss/**` MUST NOT depend on anything outside the
  open-source workspace. This keeps the collector independently buildable and extractable into
  its own repository at any time.
- Storage details stay behind the `@uptimizr/db` contracts (see [ADR 0020](./0020-open-core-storage-boundary.md))
  so the store remains swappable without touching routes, schema, or the dashboard.
- The root `LICENSE` (Apache-2.0) covers `oss/`, `examples/`, `infra/`, and `docs/`.
- The pnpm workspace globs and CI lint enforce the structure; the rule is documented in
  `pnpm-workspace.yaml`, `AGENTS.md`, and the monorepo instructions file.

## Consequences

### Positive

- The collector can be extracted to its own repository as a directory move plus dependency
  check, not a refactor.
- Clear, single licensing story for the whole repository.
- Contributors always work within one self-contained open-source workspace.

### Negative / trade-offs

- Requires discipline and automated checks to keep `oss/**` free of outside dependencies.

## Alternatives considered

- **No explicit structure (single blended app)** — fastest short-term, but would entangle
  packages and make a future repo extraction costly.

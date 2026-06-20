# ADR 0004: OSS / hosted separation in one monorepo

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** Project owner, engineering

## Context

The project ships an open-source data-collector (Apache-2.0) and a proprietary hosted SaaS. For
now they live in one repository for development velocity, but the owner intends to split the OSS
part into its own repository later. We must prevent accidental coupling that would make that
split painful, and we must keep licensing boundaries clear.

## Decision

- Top-level directories define the boundary: **`oss/`** (Apache-2.0) and **`hosted/`**
  (proprietary). Shared OSS packages live under `oss/packages/*`.
- **Dependency direction is one-way:** `hosted/**` MAY depend on `oss/**` packages;
  `oss/**` MUST NOT depend on `hosted/**`. This keeps the OSS product self-contained and
  independently extractable.
- The root `LICENSE` (Apache-2.0) covers `oss/`, `examples/`, `infra/`, and `docs/`. The
  `hosted/` tree carries its own proprietary notice.
- The pnpm workspace globs and CI lint enforce the structure; the rule is documented in
  `pnpm-workspace.yaml`, `AGENTS.md`, and the monorepo instructions file.

## Consequences

### Positive

- The future repo split is a directory move plus dependency check, not a refactor.
- Clear licensing story per directory.
- Contributors always know which side of the boundary they are working on.

### Negative / trade-offs

- Requires discipline and (eventually) automated checks to prevent illegal imports.
- Some duplication may be preferable to sharing code "upward" from hosted into OSS.

## Alternatives considered

- **Two separate repositories from day one** — cleanest boundary, but slows early, fast-moving
  cross-cutting development.
- **No explicit boundary (single blended app)** — fastest short-term, but would entangle
  proprietary and OSS code and make the planned split very costly.

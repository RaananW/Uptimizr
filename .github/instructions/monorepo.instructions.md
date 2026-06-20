---
description: Monorepo structure, OSS boundaries, and workspace conventions for Uptimizr.
applyTo: "**"
---

# Monorepo & separation rules

- This is a pnpm + Turborepo monorepo. Workspace globs are defined in `pnpm-workspace.yaml`:
  `oss/apps/*`, `oss/packages/*`, `examples/*`.
- **Self-contained OSS (ADR 0004):**
  - `oss/**` is Apache-2.0 and self-contained.
  - Keep storage details behind the `@uptimizr/db` contracts so the store stays swappable.
- Licensing: the root `LICENSE` (Apache-2.0) covers `oss/`, `examples/`, `infra/`, `docs/`.

# Package conventions

- Every package/app has its own `package.json` and a `tsconfig.json` that extends
  `../../tsconfig.base.json` (adjust relative depth as needed).
- Scope packages as `@uptimizr/<name>`. Mark internal-only apps `"private": true`.
- ESM only: `"type": "module"`. Use `import type { ... }` for type-only imports
  (`verbatimModuleSyntax` is on).
- Expose tasks named `build`, `lint`, `typecheck`, `test`, `dev`, `clean` so Turborepo can
  orchestrate them. Declare build outputs so caching works.

# Workflow

- Run tasks from the repo root via Turborepo (`pnpm build`, `pnpm lint`, etc.), not by cd-ing
  into packages, unless debugging a single package.
- Before completing a change, run `pnpm lint typecheck build` (and `test` where relevant).
- Keep changes within a phase (see `docs/phases`). Don't scaffold Phase 2 code during Phase 1.
- Document as you build: any new feature, option, event, endpoint, or user-visible improvement must
  reach the public docs site (`oss/apps/docs`) and the SDK/API reference (`docs/integration.md`)
  where applicable, in the same change. A feature isn't done until it's documented.

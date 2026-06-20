# Phase 0 — Foundation

> **Goal:** establish a documented, well-structured monorepo with agent tooling and CI, so all
> later feature work is consistent and easy to automate. **No feature code in this phase.**

## Steps

1. **Version control** — `git init`, default branch `main`, `.gitignore`, Apache-2.0 `LICENSE`.
2. **Monorepo config** — `package.json`, `pnpm-workspace.yaml`, `turbo.json`,
   `tsconfig.base.json`, `.nvmrc`, `.npmrc`.
3. **Lint/format** — flat-config ESLint (`eslint.config.mjs`), Prettier
   (`.prettierrc.json`, `.prettierignore`).
4. **Directory skeleton** — `oss/{apps,packages}`, `examples/`, `infra/`, each with a
   README describing intent (placeholders only).
5. **Documentation** — architecture overview, ADRs (0001–0006), phase plans, `CONTRIBUTING.md`,
   `.env.example`.
6. **Agent customization** — `AGENTS.md`, `.github/copilot-instructions.md`, scoped
   `.instructions.md` files, and skills under `.github/skills/`.
7. **CI** — GitHub Actions running install + lint + typecheck + build + test through Turborepo.

## Deliverables

- A repository that installs, lints, type-checks, and builds cleanly (even with placeholder
  packages).
- Documented decisions (ADRs) for stack, database, privacy, separation, backend, and replay.
- Agent instructions and skills enabling consistent, automated contributions.
- Green CI on the first commit.

## Verification

- `pnpm install` succeeds.
- `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` run via Turborepo without error
  (no-op where packages are placeholders).
- All ADRs and phase docs are present and cross-linked.
- CI workflow passes on the initial push.

## Exit criteria

Phase 0 is complete when the foundation builds green in CI and the documentation set (README,
ADRs, phase plans, CONTRIBUTING, AGENTS) is in place. Only then does Phase 1 begin.

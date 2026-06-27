# Copilot / AI agent instructions — Uptimizr

> These repository-wide instructions apply to all AI-assisted work. They mirror and condense
> [`AGENTS.md`](../AGENTS.md). Read that file and the [ADRs](../docs/adr) for full context.

## Project in one paragraph

Uptimizr is a 3D-scene analytics platform (Google-Analytics-for-3D). It captures view-direction
and pointer/click heatmaps, mesh interactions, session/perf, and custom events from 3D scenes,
and can replay a session in the developer's own scene. This repository is the open-source
data-collector (`oss/`, Apache-2.0): SDKs, the ingestion/query collector, the dashboard, and an
embedded DuckDB store.

## Non-negotiable rules

1. **Storage seam:** the OSS collector self-hosts on a single embedded DuckDB file. Optional
   ClickHouse/Postgres scale engines plug in behind the `@uptimizr/db` store contracts — keep
   storage details behind those contracts so the store stays swappable. (ADR 0004 / ADR 0020)
2. **Events live once** in `@uptimizr/schema` (Zod). Import event types; never redefine them.
   Keep events replay-complete (ordered, timestamped, `sessionId`-keyed).
3. **Privacy first:** no client persistent IDs, no PII by default; visitor ID is a server-side
   daily-rotating hash; raw session retention is opt-in. (ADR 0003)
4. **TypeScript strict**, ESM, `import type` for types; validate external input with Zod at the
   boundary.
5. **Thin backends:** keep logic in framework-agnostic packages. Fastify is the Phase 1 API
   framework. (ADR 0005)
6. **Respect phases:** don't implement Phase 2 features in Phase 1. See `docs/phases`.
7. **Document decisions** as new ADRs; never edit historical ADRs.
8. **Every feature reaches the docs:** any new feature, option, event, endpoint, or user-visible
   improvement must be documented in the same change — update the public docs site
   (`oss/apps/docs`) and the SDK/API reference (`docs/integration.md`) where applicable. A feature
   isn't done until it's documented.

## When you change things

- Run `pnpm lint typecheck build` (and `test` where relevant) before finishing.
- Update or add docs/ADRs when behavior or decisions change.
- Reflect any new feature/option/event/endpoint in the public docs site (`oss/apps/docs`) and
  `docs/integration.md` in the same change.
- Add a **changeset** (`pnpm changeset`) for any change to a publishable `@uptimizr/*` package, and
  add/extend a **Playwright E2E** under `examples/playground/e2e/` for any user-visible or
  full-stack change (capture → collector → dashboard/replay), per the `work-on-issue` skill.
- When opening a pull request, populate every section of `.github/PULL_REQUEST_TEMPLATE.md`
  (Summary, Linked issue, Type of change, Checklist, AI-assisted contribution) and tick each
  checklist item honestly — call out anything intentionally skipped. The `create-pr` skill walks
  the full gate.
- Use Conventional Commits.
- Prefer editing existing files; don't create one-off markdown summaries.

## Pointers

- Architecture: `docs/architecture/overview.md`
- Integration & API reference (track / replay / HTTP API): `docs/integration.md`
- Build plan: `docs/phases/`
- Decisions: `docs/adr/`
- Scoped rules: `.github/instructions/*.instructions.md`
- Reusable workflows: `.github/skills/*`

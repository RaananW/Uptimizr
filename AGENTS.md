# AGENTS.md — Working in the Uptimizr repository

This file orients AI coding agents (and humans) working in this repo. Read it before making
changes. For decision rationale, see [`docs/adr`](./docs/adr); for the build plan, see
[`docs/phases`](./docs/phases).

## What this project is

Uptimizr is a **3D-scene analytics platform** — like Google Analytics, but for 3D apps. It
captures view-direction heatmaps, pointer/click heatmaps, mesh interactions, session/perf, and
custom events from a 3D scene, and can **replay** a session in the developer's own scene.

This repository is the **open-source, Apache-2.0, self-hostable data-collector**: SDKs, the
ingestion/query collector, the dashboard, and an embedded DuckDB store.

## Golden rules

1. **Keep the storage seam clean.** The OSS collector self-hosts on a single embedded DuckDB
   file. Optional ClickHouse/Postgres scale engines plug in behind the `@uptimizr/db` store
   contracts — keep storage details behind those contracts so the store stays swappable.
   (ADR 0020)
2. **One source of truth for events.** All event shapes live in `@uptimizr/schema` as Zod
   schemas. Never redefine an event type elsewhere — import it. Events must be replay-complete
   (ordered, timestamped, keyed by `sessionId`).
3. **Privacy first.** No client-side persistent IDs, no PII by default. The visitor ID is a
   server-side daily-rotating hash. Raw per-session retention is opt-in. (ADR 0003)
4. **TypeScript strict, validate at boundaries.** Validate external input with Zod at the edge.
5. **Keep backends thin.** Business logic lives in framework-agnostic packages so the API layer
   (Fastify now; possibly Hono at the edge later) stays replaceable. (ADR 0005)
6. **Document decisions.** Significant choices get a new ADR (`docs/adr/template.md`). Do not
   rewrite past ADRs — supersede them.
7. **Phase discipline.** Don't build Phase 2 features during Phase 1. Check `docs/phases`.
8. **Every feature reaches the docs.** Any new feature, option, event, endpoint, or user-visible
   improvement MUST be documented in the same change: update the public docs site
   (`oss/apps/docs`) and the SDK/API reference (`docs/integration.md`) where applicable. A feature
   isn't done until it's documented.

## Repository map

```
oss/apps/collector-server   Fastify ingestion + query API
oss/apps/dashboard          Next.js + Tailwind dashboard
oss/packages/schema         @uptimizr/schema   (Zod contracts + types) — build first
oss/packages/sdk-core       @uptimizr/sdk-core (session, batch, beacon, cookieless)
oss/packages/sdk-babylon    @uptimizr/babylon  (Babylon.js collector adapter)
oss/packages/replay         @uptimizr/replay   (re-drive a session in the user's scene)
oss/packages/db             @uptimizr/db       (DuckDB store + dialect-agnostic query contracts)
examples/playground         Multi-engine demo scene for E2E testing
infra/docker                docker-compose: optional ClickHouse + Postgres scale tier
docs/                       architecture, phases, ADRs
```

## Tech stack

pnpm + Turborepo · TypeScript (Node 22) · Fastify · Next.js + Tailwind · ClickHouse (events) +
Postgres (metadata) · Babylon.js (first connector) · Zod contracts.

## Commands (run from repo root)

```bash
pnpm install
pnpm build       # turbo build
pnpm lint
pnpm typecheck
pnpm test
pnpm format
```

Always run `pnpm lint typecheck build` (and `test` where applicable) before considering a change
complete.

## Conventions

- **Module system:** ESM (`"type": "module"`), `verbatimModuleSyntax`; use
  `import type { ... }` for type-only imports.
- **Packages:** scoped `@uptimizr/*`; each package has its own `package.json` + `tsconfig.json`
  extending `tsconfig.base.json`.
- **Commits:** Conventional Commits (`feat(...)`, `fix(...)`, `docs(...)`, `chore(...)`).
- **Tests:** Vitest for unit/integration. **Major / user-visible features also require a
  Playwright E2E** under `examples/playground/e2e/` that drives the real browser → SDK → collector
  → dashboard/replay round trip (`work-on-issue` skill, step 4).

## Task-specific guides

Scoped instruction files under [`.github/instructions`](./.github/instructions) apply to matching
paths. Reusable workflows live as skills under [`.github/skills`](./.github/skills):

- `add-event-type` — add a new analytics event end-to-end.
- `add-connector` — add a new 3D engine connector.
- `add-migration` — write a hand-written SQL migration (ClickHouse/Postgres, ADR 0007).
- `query-analytics` — query collected analytics via the collector read API (auth, params, gotchas).
- `run-local-stack` — bring up ClickHouse + Postgres + services locally.
- `work-on-issue` — take a GitHub issue from assigned to closed (plan, code, review, test, close).

Focused **custom agents** live under [`.github/agents`](./.github/agents). Use them as subagents
(or pick them in chat) when a task matches their role; a parent agent may delegate based on the
agent's `description`:

- `schema-guardian` — invoke when **adding or changing an analytics event**, or reviewing a schema
  edit. It enforces "events live once" and replay-completeness on `@uptimizr/schema`, then hands
  the cross-package threading to the `add-event-type` skill.
- `connector-author` — invoke when **adding or maintaining a 3D engine connector** (three.js,
  PlayCanvas, react-three-fiber, …). It mirrors `@uptimizr/babylon` per the `add-connector`
  skill (sdk-core + schema only, engine as a peer dep, `dispose()` cleanup, no persistent IDs).
  New connectors are Phase 2 scope — confirm phase intent first.

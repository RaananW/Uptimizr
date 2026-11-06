# AGENTS.md — Working in the Uptimizr repository

This file orients AI coding agents (and humans) working in this repo. Read it before making
changes. For decision rationale, see [`docs/adr`](./docs/adr); for the build plan, see
[`docs/phases`](./docs/phases).

## What this project is

Uptimizr is a **3D-scene analytics platform** — like web analytics, but for 3D apps. It
captures view-direction heatmaps, pointer/click heatmaps, mesh interactions, session/perf, and
custom events from a 3D scene, and can **replay** a session in the developer's own scene.

This repository is the **open-source, Apache-2.0, self-hostable data-collector**: SDKs, the
ingestion/query collector, the dashboard, and an embedded DuckDB store.

## Golden rules

1. **Keep the storage seam clean.** The OSS collector self-hosts on a single embedded DuckDB
   file. Optional Postgres, SQL Server and ClickHouse engines plug in behind the `@uptimizr/db`
   store contracts — keep storage details behind those contracts so the store stays swappable.
   (ADR 0020)
2. **One source of truth for events.** All event shapes live in `@uptimizr/schema` as Zod
   schemas. Never redefine an event type elsewhere — import it. Events must be replay-complete
   (ordered, timestamped, keyed by `sessionId`).
3. **Privacy first.** No client-side persistent IDs, no PII by default. The visitor ID is a
   server-side daily-rotating hash. Reading raw per-session streams through the API is opt-in;
   events themselves are always stored. (ADR 0003)
4. **TypeScript strict, validate at boundaries.** Validate external input with Zod at the edge.
5. **Keep backends thin.** Business logic lives in framework-agnostic packages so the API layer
   (Fastify now; possibly Hono at the edge later) stays replaceable. (ADR 0005)
6. **Document decisions.** Significant choices get a new ADR (`docs/adr/template.md`). Do not
   rewrite past ADRs — supersede them.
7. **OSS boundary discipline.** The OSS collector is self-contained; don't build
   proprietary/hosted-only features here. Check `docs/phases`.
8. **Every feature reaches the docs.** Any new feature, option, event, endpoint, or user-visible
   improvement MUST be documented in the same change: update the public docs site
   (`oss/apps/docs`) and the SDK/API reference (`docs/integration.md`) where applicable. A feature
   isn't done until it's documented.

## Repository map

```
oss/apps/collector-server   Fastify ingestion + query API, OpenAPI, audit, CLI
oss/apps/dashboard          Next.js + Tailwind dashboard
oss/apps/docs               Astro Starlight documentation site (uptimizr.com/docs)
oss/apps/web                Astro marketing site (uptimizr.com)
oss/apps/demo               In-browser test drive (playground + dashboard, no server)

oss/packages/schema         @uptimizr/schema     (Zod contracts + types) — build first
oss/packages/sdk-core       @uptimizr/sdk-core   (session, batch, beacon, cookieless)
oss/packages/replay         @uptimizr/replay     (re-drive a session in the user's scene)
oss/packages/heatmap        @uptimizr/heatmap    (in-scene heatmap overlays)
oss/packages/react          @uptimizr/react      (embeddable panel catalog + CollectorApi)
oss/packages/create-uptimizr create-uptimizr     (self-host scaffolder)

oss/packages/metrics        @uptimizr/metrics    (semantic metric registry — the agent source of truth)
oss/packages/agent-core     @uptimizr/agent-core (generated read-tool catalog, LLM adapter, agent loop)
oss/packages/mcp            @uptimizr/mcp        (MCP server over the query API; events read-only)
oss/packages/agent-eval     @uptimizr/agent-eval (PRIVATE — the agent evaluation harness, not published)

oss/packages/db             @uptimizr/db           (DuckDB store + dialect-agnostic query contracts)
oss/packages/db-postgres    @uptimizr/db-postgres  (optional Postgres store)
oss/packages/db-mssql       @uptimizr/db-mssql     (optional SQL Server store)
oss/packages/db-clickhouse  @uptimizr/db-clickhouse(optional ClickHouse scale tier)

oss/packages/sdk-babylon      @uptimizr/babylon       (Babylon.js connector)
oss/packages/sdk-babylon-lite @uptimizr/babylon-lite  (dependency-free Babylon connector)
oss/packages/sdk-three        @uptimizr/three         (three.js connector)
oss/packages/sdk-r3f          @uptimizr/r3f           (react-three-fiber connector)
oss/packages/sdk-playcanvas   @uptimizr/playcanvas    (PlayCanvas connector)
oss/packages/sdk-aframe       @uptimizr/aframe        (A-Frame / WebXR connector)
oss/packages/web-export       @uptimizr/web-export    (web-export foundation)
oss/packages/unity            @uptimizr/unity         (Unity WebGL export bridge)
oss/packages/godot            @uptimizr/godot         (Godot web export bridge)
oss/packages/unreal           @uptimizr/unreal        (Unreal web export bridge)

examples/playground         Multi-engine demo scene for E2E testing
examples/godot-web-export   Godot 4 reference integration for @uptimizr/godot
examples/unity-web-export   Unity 6 sample project for @uptimizr/unity
infra/docker                docker-compose: optional ClickHouse, Postgres and SQL Server engines
docs/                       architecture, phases, ADRs
```

## Tech stack

pnpm + Turborepo · TypeScript (Node 22) · Fastify · Next.js + Tailwind · DuckDB (default store) ·
optional Postgres, SQL Server and ClickHouse stores · connectors for Babylon.js, Babylon Lite,
three.js, react-three-fiber, PlayCanvas, A-Frame and web exports · Zod contracts.

## Commands (run from repo root)

```bash
pnpm install
pnpm build       # turbo build
pnpm lint
pnpm typecheck
pnpm test
pnpm format
pnpm gen:docs    # re-render the metric tables generated from the registry
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
- **Generated metric tables:** the endpoint/tool tables in `docs/integration.md`, the docs-site
  `api/query` page and the packaged `README`/`AGENTS.md`/`llms.txt` of `@uptimizr/mcp` and
  `@uptimizr/agent-core` are **generated** from the metric registry (ADR 0051) by
  `scripts/gen-registry-docs.mjs`. Never hand-edit the text between the `generated:*:start`/`:end`
  markers — change the registry and run `pnpm gen:docs`. `pnpm gen:docs:check` is the CI gate.
- **Packaged agent skills:** the curated investigation methodologies are authored as Agent Skills
  files in `oss/packages/agent-core/skills/<name>/SKILL.md` and compiled into
  `src/skills.generated.ts` by `scripts/gen-agent-skills.mjs` (ADR 0051 §7). They ship in the
  `@uptimizr/agent-core` and `@uptimizr/mcp` tarballs and back the MCP prompts, the
  `uptimizr agent report --skill` CLI and the assistant's starter prompts. Edit the SKILL.md, then
  run `pnpm format && pnpm gen:skills`; `pnpm gen:skills:check` is the CI gate.
- **SDK version constant:** `SDK_VERSION` in `oss/packages/sdk-core/src/version.ts` is **generated**
  from the package's `package.json` by `scripts/gen-sdk-version.mjs`, because browser code cannot read
  its manifest at runtime. `pnpm version:packages` regenerates it after `changeset version`;
  `pnpm gen:version:check` is the CI gate.
- **Changesets:** every PR needs a changeset (CI fails without one). Use `pnpm changeset` for a
  change to a publishable `@uptimizr/*` package — it drives the release/version bump — and
  `pnpm changeset --empty` when nothing is released.
- **Pull requests:** fill out every section of `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Linked
  issue, Type of change, Checklist, AI-assisted contribution) and tick each checklist item
  honestly, flagging anything intentionally skipped. The `create-pr` skill reproduces the full gate
  locally first.

## Task-specific guides

Scoped instruction files under [`.github/instructions`](./.github/instructions) apply to matching
paths. Reusable workflows live as skills under [`.github/skills`](./.github/skills):

- `add-event-type` — add a new analytics event end-to-end.
- `add-connector` — add a new 3D engine connector.
- `add-migration` — write a hand-written SQL migration across the four stores (ADR 0007).
- `query-analytics` — query collected analytics via the collector read API (auth, params, gotchas).
- `run-local-stack` — bring up the local stack (DuckDB; Docker only for the optional stores).
- `work-on-issue` — take a GitHub issue from assigned to closed (plan, code, review, test, close).
- `create-pr` — open a PR that passes CI on the first run (reproduce every gate locally first).

Focused **custom agents** live under [`.github/agents`](./.github/agents). Use them as subagents
(or pick them in chat) when a task matches their role; a parent agent may delegate based on the
agent's `description`:

- `schema-guardian` — invoke when **adding or changing an analytics event**, or reviewing a schema
  edit. It enforces "events live once" and replay-completeness on `@uptimizr/schema`, then hands
  the cross-package threading to the `add-event-type` skill.
- `connector-author` — invoke when **adding or maintaining a 3D engine connector** (three.js,
  PlayCanvas, react-three-fiber, …). It mirrors `@uptimizr/babylon` per the `add-connector`
  skill (sdk-core + schema only, engine as a peer dep, `dispose()` cleanup, no persistent IDs).
  New web-export connectors (Unity, Godot, Unreal) follow ADR 0045 — confirm the engine-side
  bridge approach first.

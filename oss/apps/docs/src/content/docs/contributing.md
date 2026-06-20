---
title: Contributing
description: Work on Uptimizr itself — clone the monorepo, run it from source, and follow the project conventions.
---

These docs are for **using** Uptimizr — you install a connector from npm and self-host the collector
([Run the collector](/docs/deploy/collector/)). This page is the short version for the other
audience: people who want to **help build the open-source project**.

Uptimizr is developed as a single pnpm + Turborepo monorepo on GitHub. You only need the repo if you
are changing Uptimizr's own code — not to run it.

## Quick start (from source)

```bash
git clone https://github.com/RaananW/Uptimizr.git
cd Uptimizr
pnpm install
cp .env.example .env

pnpm build       # build all packages
pnpm lint
pnpm typecheck
pnpm test
```

Run the collector + dashboard from source while you work:

```bash
pnpm db:setup        # create the DuckDB file + seed a project & API key
pnpm dev:collector   # Fastify ingestion + query API (COLLECTOR_STORE=duckdb)
pnpm dev:dashboard   # optional: the analytics dashboard
```

For the full end-to-end loop (collector, dashboard, a playground scene, replay), see the repo's
manual testing guide and the `run-local-stack` workflow.

## House rules

- **Self-contained OSS.** `oss/` is Apache-2.0 and self-contained; keep storage details behind the
  `@uptimizr/db` contracts so the store stays swappable.
- **Events live once.** Every event shape is a Zod schema in `@uptimizr/schema`; import event types,
  never redefine them. Keep events replay-complete (ordered, timestamped, `sessionId`-keyed).
- **Privacy first.** No client-side persistent IDs and no PII by default.
- **TypeScript strict**, ESM, validate external input with Zod at the boundary.
- **Conventional Commits**, and add an ADR for significant decisions.

The authoritative, always-current version of these rules lives in
[`CONTRIBUTING.md`](https://github.com/RaananW/Uptimizr/blob/main/CONTRIBUTING.md) and
[`AGENTS.md`](https://github.com/RaananW/Uptimizr/blob/main/AGENTS.md) in the repo. Start there, then
open an issue or PR.

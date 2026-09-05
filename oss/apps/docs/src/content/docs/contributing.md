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

To work on the **ClickHouse scale store** (`COLLECTOR_STORE=clickhouse`), start a local ClickHouse
and point the collector at it:

```bash
pnpm stack:up        # ClickHouse on :8123 (infra/docker)
COLLECTOR_STORE=clickhouse pnpm dev:collector
```

The store creates its database and tables on first boot. A live ClickHouse also unlocks the
cross-engine parity tests in `@uptimizr/db-clickhouse` (they skip gracefully when it is unreachable,
so the default `pnpm test` stays Docker-free).

The same applies to the **Postgres store** (`COLLECTOR_STORE=postgres`): `pnpm stack:up` also
starts a `postgres:16` service, and the parity + store suites in `@uptimizr/db-postgres` run
against it whenever `POSTGRES_URL` (or `DATABASE_URL`) is reachable — they assert every
aggregation against both the golden output and DuckDB directly, and skip otherwise:

```bash
pnpm stack:up
COLLECTOR_STORE=postgres POSTGRES_URL=postgresql://uptimizr:uptimizr@localhost:5432/uptimizr pnpm dev:collector
POSTGRES_URL=postgresql://uptimizr:uptimizr@localhost:5432/uptimizr pnpm --filter @uptimizr/db-postgres test
```

In CI the opt-in **Store parity (Postgres)** job runs the same suite against a service container.

Likewise for the **SQL Server store** (`COLLECTOR_STORE=mssql`): `pnpm stack:up` starts a
`mcr.microsoft.com/mssql/server:2022-latest` service, and the parity + store suites in
`@uptimizr/db-mssql` run against it whenever the server behind `MSSQL_URL` (or the discrete
`MSSQL_*` variables) is reachable, in throwaway databases they create and drop:

```bash
pnpm stack:up
MSSQL_URL="Server=localhost,1433;Database=master;User Id=sa;Password=Uptimizr!Local1;Encrypt=false;TrustServerCertificate=true" pnpm --filter @uptimizr/db-mssql test
```

In CI the opt-in **Store parity (MSSQL)** job runs it against a SQL Server 2022 service container
with `MSSQL_PARITY_REQUIRED=1`, so an unreachable server fails instead of skipping.

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

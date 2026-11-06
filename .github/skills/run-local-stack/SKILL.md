---
name: run-local-stack
description: Bring up the local Uptimizr dev stack. The OSS default needs NO Docker — a single DuckDB file holds events + metadata. Postgres, SQL Server and ClickHouse (via Docker) are optional stores only. USE FOR: running locally, starting the dev environment, self-hosting the collector, end-to-end testing. Trigger phrases: run locally, start the stack, local dev environment, no docker, duckdb, docker compose up.
---

# Skill: Run the local stack

Stand up the OSS development environment for local testing and end-to-end verification.

> The **OSS default store is DuckDB** (ADR 0020): a single `.duckdb` file holds both events and
> metadata, so the collector self-hosts in **one process with no external database service**.
> Postgres, SQL Server and ClickHouse are **optional stores**, each self-contained, and are only
> needed for multi-writer / horizontal scale or a database you already run — see
> [Scale path](#scale-path-docker).

> For the full step-by-step manual walkthrough (smoke-test curls, dashboard, playground,
> replay, store inspection, troubleshooting), see [`docs/manual-testing.md`](../../../docs/manual-testing.md).
> Keep that doc and this skill in sync when commands, ports, or env vars change.

## OSS quickstart (no Docker)

Root `pnpm` scripts wrap each env-dependent command in `dotenv`, so the root `.env` is loaded
automatically (no `source .env`). The playground reads `VITE_*` from the same root `.env`.

1. **Prepare env.**
   - `cp .env.example .env` and adjust if needed (ports, secrets). **No Docker required.**
   - `pnpm install && pnpm build` once.

2. **Create the store + a project.**
   - `pnpm db:setup` migrates the DuckDB file at `DUCKDB_PATH` (default `./data/uptimizr.duckdb`)
     and seeds the demo projects + API keys. It writes them into your existing `.env`
     (`VITE_PROJECT_ID`, `VITE_API_KEY`, `NEXT_PUBLIC_API_KEY`, and the walkable pair) and prints
     each key once.
   - **Leave `DUCKDB_PATH` unset in the monorepo.** When unset it resolves to
     `<repo-root>/data/uptimizr.duckdb` for every tool. A _relative_ `DUCKDB_PATH` is resolved
     against each tool's own cwd, so the seed (run in `oss/packages/db`) and the collector (run in
     `oss/apps/collector-server`) would write/read different files — the dashboard then sends keys
     the collector never saw and you get `401 invalid api key`. If you must set it, use an
     **absolute** path.
   - The collector defaults to `COLLECTOR_STORE=duckdb`; nothing else to start.

3. **Start services.**
   - `pnpm dev:collector` — Fastify ingestion + query API (opens the DuckDB file).
   - `pnpm dev:dashboard` — Next.js dashboard.
   - `pnpm dev:playground` — multi-engine demo scene.

4. **Exercise it.**
   - Interact with the playground scene to generate events.
   - Confirm events appear in the dashboard. To inspect the store directly, stop the collector
     first (or copy the file) and use the DuckDB CLI:
     `duckdb ./data/uptimizr.duckdb "SELECT event_type, count(*) FROM events GROUP BY 1"`.

5. **Back up / reset.**
   - **Back up** = copy the `.duckdb` file. **Reset** = delete it and re-run `pnpm db:setup`.

> **Single-writer constraint.** DuckDB is an embedded, single-writer store: only **one process**
> may open the file read-write at a time. Run a single collector instance against a given file.
> Read-only access beside a running collector is not guaranteed, so stop the collector or inspect a
> copy of the file. For multi-writer / horizontal scale, use an optional Postgres, SQL Server or
> ClickHouse store.

## Scale path (Docker)

Postgres, SQL Server and ClickHouse each back an optional, self-contained store behind the
`@uptimizr/db` store contracts: one engine holds both events and metadata.

1. `pnpm stack:up` — ClickHouse (`:8123`), Postgres (`:5432`), SQL Server (`:1433`), and Adminer
   (`:8080`) for inspection. The Compose project is pinned to `uptimizr-oss`, so the containers are
   `uptimizr-oss-clickhouse`, `uptimizr-oss-postgres`, `uptimizr-oss-mssql` and
   `uptimizr-oss-adminer`, and the volumes are `uptimizr-oss_*` whichever checkout or worktree you
   run it from. Every host port is overridable in `.env` (`CLICKHOUSE_HTTP_HOST_PORT`,
   `CLICKHOUSE_NATIVE_HOST_PORT`, `POSTGRES_HOST_PORT`, `MSSQL_HOST_PORT`, `ADMINER_HOST_PORT`); the
   connection URLs in `.env` reference those variables, so they follow.
2. Point the collector at one engine with `COLLECTOR_STORE` and its connection env vars; the store
   migrates on boot. `pnpm db:*` targets DuckDB only, so mint a project in another store with the
   `uptimizr` CLI (`init` / `new-project`), which honours `COLLECTOR_STORE`.
3. Run the store parity suites through the same `.env` so they hit the overridden ports:
   `pnpm test:parity:postgres`, `pnpm test:parity:mssql` or `pnpm test:parity:clickhouse`.
4. Tear down: `pnpm stack:down` (or `docker compose -f infra/docker/docker-compose.yml down -v` to
   drop data volumes).

## Troubleshooting

- **`IO Error: Could not set lock on file ... uptimizr.duckdb`:** another process already holds the
  DuckDB write lock (single-writer). Stop the other collector/CLI, then retry.
- **Port conflicts (scale path):** set the matching `*_HOST_PORT` variable in `.env` (not
  `.env.example`) and re-run `pnpm stack:up`; the connection URLs follow it.
- **Empty dashboard:** check CORS origins (`COLLECTOR_CORS_ORIGINS`) and that the playground
  points at the right collector URL.
- **No rows:** confirm `pnpm db:setup` ran and the collector's batched insert flushed.

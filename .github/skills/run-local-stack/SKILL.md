---
name: run-local-stack
description: Bring up the local Uptimizr dev stack. The OSS default needs NO Docker — a single DuckDB file holds events + metadata. ClickHouse + Postgres (via Docker) are the optional scale tier only. USE FOR: running locally, starting the dev environment, self-hosting the collector, end-to-end testing. Trigger phrases: run locally, start the stack, local dev environment, no docker, duckdb, docker compose up.
---

# Skill: Run the local stack

Stand up the OSS development environment for local testing and end-to-end verification.

> The **OSS default store is DuckDB** (ADR 0020): a single `.duckdb` file holds both events and
> metadata, so the collector self-hosts in **one process with no external database service**.
> ClickHouse + Postgres are the **optional scale tier** and are only needed for multi-writer /
> horizontal scale — see [Scale path](#scale-path-docker).

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
     and seeds a demo project + API key. Paste the printed `PROJECT_ID` / `utk_...` key into `.env`
     (`VITE_PROJECT_ID`, `VITE_API_KEY`, optionally `NEXT_PUBLIC_API_KEY`).
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
   - `pnpm dev:playground` — Babylon demo scene.

4. **Exercise it.**
   - Interact with the playground scene to generate events.
   - Confirm events appear in the dashboard. Inspect the store directly with the DuckDB CLI:
     `duckdb ./data/uptimizr.duckdb "SELECT event_type, count(*) FROM events GROUP BY 1"`.

5. **Back up / reset.**
   - **Back up** = copy the `.duckdb` file. **Reset** = delete it and re-run `pnpm db:setup`.

> **Single-writer constraint.** DuckDB is an embedded, single-writer store: only **one process**
> may open the file read-write at a time. Run a single collector instance against a given file;
> stop it before inspecting the file with another writer. Concurrent readers are fine in read-only
> mode. For multi-writer / horizontal scale, use the optional ClickHouse scale tier.

## Scale path (Docker)

The ClickHouse (events) + Postgres (metadata) engines back the optional scale tier behind the
`@uptimizr/db` store contracts. Only needed for multi-writer / horizontal scale.

1. `pnpm stack:up` — ClickHouse (`:8123`), Postgres (`:5432`), and Adminer for inspection.
2. Run the scale-tier migrations/seed against those engines, then point the collector at them via
   the relevant `COLLECTOR_STORE` / connection env vars.
3. Tear down: `pnpm stack:down` (or `docker compose -f infra/docker/docker-compose.yml down -v` to
   drop data volumes).

## Troubleshooting

- **`IO Error: Could not set lock on file ... uptimizr.duckdb`:** another process already holds the
  DuckDB write lock (single-writer). Stop the other collector/CLI, then retry.
- **Port conflicts (scale path):** adjust ports in `.env` / compose file.
- **Empty dashboard:** check CORS origins (`COLLECTOR_CORS_ORIGINS`) and that the playground
  points at the right collector URL.
- **No rows:** confirm `pnpm db:setup` ran and the collector's batched insert flushed.

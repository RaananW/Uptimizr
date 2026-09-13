# `infra/`

Local and deployment infrastructure for Uptimizr.

- `docker/` — `docker compose` bringing up ClickHouse + Postgres + SQL Server (+ Adminer) for the
  optional **scale** tier. The current ClickHouse store keeps events and metadata in
  ClickHouse behind the `@uptimizr/db` contracts (ADR 0020); the default OSS collector
  does **not** need these services.

Cloud-agnostic and Docker-first by design.

## OSS local run (no Docker)

The open-source collector self-hosts on a single embedded DuckDB file — no database
container required:

```bash
cp .env.example .env                                 # from repo root; DUCKDB_PATH defaults to ./data/uptimizr.duckdb
pnpm db:setup                                        # migrate the DuckDB store + seed a demo project & API key
pnpm dev:collector                                   # :4318
pnpm dev:dashboard                                   # :3000
```

Back up = copy the `.duckdb` file. DuckDB is single-writer: run one collector per file.

## Scale stack (Docker)

ClickHouse, Postgres and SQL Server are only needed when exercising the optional stores:

```bash
pnpm stack:up     # from repo root: ClickHouse :8123, Postgres :5432, SQL Server :1433, Adminer :8080
pnpm stack:down   # stop, keep data
docker compose -f infra/docker/docker-compose.yml down -v   # stop and drop the data volumes
```

The Compose project name is pinned to `uptimizr-oss`, so the containers are `uptimizr-oss-*` and
the volumes `uptimizr-oss_*` regardless of the checkout, fork or worktree they are started from.
Without the pin, Compose would name the project after the `docker` folder, so any other repository
with the same `infra/docker` layout would replace these containers and reuse their volumes.

The host ports above are defaults. Override them in the repo-root `.env` with
`CLICKHOUSE_HTTP_HOST_PORT`, `CLICKHOUSE_NATIVE_HOST_PORT`, `POSTGRES_HOST_PORT`,
`MSSQL_HOST_PORT` and `ADMINER_HOST_PORT`; the connection URLs in `.env` reference those
variables, so `pnpm db:*`, `pnpm dev:*` and `pnpm test:parity:*` follow them.

- **Adminer** (`http://localhost:8080`) inspects Postgres (projects, api_keys).
- **ClickHouse** events are queryable over the HTTP interface (`http://localhost:8123`).
- See the `run-local-stack` skill for the full end-to-end walkthrough.

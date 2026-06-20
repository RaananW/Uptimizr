# `infra/`

Local and deployment infrastructure for Uptimizr.

- `docker/` — `docker compose` bringing up ClickHouse + Postgres (+ Adminer) for the
  optional **scale** tier. These engines back a ClickHouse-backed store behind the
  `@uptimizr/db` contracts (ADR 0020); the default OSS collector does **not** need them.

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

ClickHouse + Postgres are only needed for the optional scale tier:

```bash
cd infra/docker
docker compose up -d                       # ClickHouse :8123, Postgres :5432, Adminer :8080
# apply the scale migrations against these engines

# tear down (add -v to drop data volumes)
docker compose down
```

- **Adminer** (`http://localhost:8080`) inspects Postgres (projects, api_keys).
- **ClickHouse** events are queryable over the HTTP interface (`http://localhost:8123`).
- See the `run-local-stack` skill for the full end-to-end walkthrough.

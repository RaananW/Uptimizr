# @uptimizr/db-clickhouse

Optional **single-tenant ClickHouse store** for the Uptimizr collector — the
scale path for self-hosters who outgrow the default single-file DuckDB store and
need concurrent, high-volume ingestion (ADR 0020).

It is a **re-home + dialect emitter, not a rewrite**: every analytics
aggregation is authored once in [`@uptimizr/db`](../db) against the
dialect-agnostic query layer, and this package renders them to ClickHouse SQL via
the shared `clickhouseDialect`, plus a ClickHouse client, schema/migrations, and
metadata helpers that satisfy the same `CollectorStore` contract as DuckDB.

## When to use it

Stay on the default DuckDB store unless you hit DuckDB's single read-write
process ceiling (high-volume or multi-writer ingestion). ClickHouse adds columnar
scale and concurrent ingestion while staying self-hostable.

## Usage

Select it via the collector's `COLLECTOR_STORE` env var:

```bash
COLLECTOR_STORE=clickhouse \
CLICKHOUSE_URL=http://localhost:8123 \
CLICKHOUSE_DATABASE=uptimizr \
CLICKHOUSE_USER=default \
CLICKHOUSE_PASSWORD= \
  pnpm --filter @uptimizr/collector-server start
```

A local ClickHouse is available via the optional scale tier in
[`infra/docker`](../../../infra/docker):

```bash
cd infra/docker && docker compose up -d   # ClickHouse on :8123
```

For a **hosted/managed ClickHouse** (e.g. ClickHouse Cloud), point `CLICKHOUSE_URL`
at the HTTPS endpoint (`https://<host>:8443`) and pass the credentials — TLS is
inferred from the `https://` scheme. The connecting user needs the `CREATE
DATABASE` privilege (the database is created on first boot) or a pre-created
database. Custom CA bundles / mutual-TLS client certs are not currently exposed.

The schema is migrated on store creation (migrations are idempotent and
forward-only — ADR 0007), so it is usable out of the box.

## Scope

- **Single-tenant only** — no `org_id`, no tenant isolation. The multi-writer
  `AggregatingMergeTree` rollups and scale tuning remain the proprietary scale
  tier; this package is the single-instance ClickHouse adapter.
- No stubbed features — the full analytics surface (heatmaps, perf percentiles,
  click↔gaze rays) returns results identical to DuckDB on the cross-engine parity
  fixtures.

## Layout

| File               | Responsibility                                              |
| ------------------ | ----------------------------------------------------------- |
| `client.ts`        | Thin `@clickhouse/client` wrapper (HTTP, numeric coercion). |
| `migrations.ts`    | Forward-only DDL (events, node_samples, metadata, views).   |
| `events.ts`        | Batched event insert + replay-complete session reads.       |
| `projects.ts`      | Project + API-key metadata (SHA-256 hashes).                |
| `sceneRegistry.ts` | Per-`(project, scene)` representation upserts/reads.        |
| `queries.ts`       | `runClickhouseQuery` — executes a rendered `QuerySpec`.     |

The `CollectorStore` itself is assembled from these building blocks in the
collector server (`oss/apps/collector-server/src/clickhouseStore.ts`,
`createClickhouseStore`), mirroring the DuckDB store — this package stays a
store-agnostic toolkit.

Licensed Apache-2.0.

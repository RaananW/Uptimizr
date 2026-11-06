---
description: Database conventions — the DuckDB store and storage contracts, plus the optional Postgres, SQL Server and ClickHouse stores.
applyTo: "oss/packages/{db,db-postgres,db-mssql,db-clickhouse}/**"
---

# `@uptimizr/db` and the optional stores

`@uptimizr/db` holds the storage contracts, the dialect-agnostic query layer and the default
single-file DuckDB store (ADR 0020). `@uptimizr/db-postgres`, `@uptimizr/db-mssql` and
`@uptimizr/db-clickhouse` are optional stores behind the same contracts. Each store holds events
**and** metadata in one database, selected with `COLLECTOR_STORE`. All four are single-tenant.

## Events

- A wide `events` table: hot fields are promoted to columns, and the full validated event is kept
  in `payload` so reads stay replay-complete. `toEventRow` (`oss/packages/db/src/events.ts`) is the
  shared mapper.
- Every event is written regardless of `ENABLE_RAW_SESSION_RETENTION`, which gates reading raw
  per-session streams at the collector, not storage (ADR 0003). Provide an ordered read by
  `session_id` for the timeline endpoint. The only deletion is `pruneEvents`, the opt-in
  `EVENT_RETENTION_DAYS` sweep, which must cover both `events` and `node_samples` (ADR 0052).
- `node_transform` rows go to a dedicated `node_samples` table.

## Aggregations

- Define an aggregation once as a pure `buildX(projectId, opts, dialect)` builder in
  `oss/packages/db/src/query/aggregations.ts`, using `Dialect` fragments. Never hard-code engine
  SQL.
- Aggregations run at query time. The daily rollups (`perf_daily`, `events_daily`) are plain views
  on every store; there are no materialized views.
- Add a `PARITY_CASES` entry so every engine stays provably equal, and a registry entry in
  `@uptimizr/metrics`.

## Metadata

- `projects`, `api_keys`, the scene registry, project metadata, subscriptions and the agent audit
  log live in the same store as events.
- API keys: store only hashes, never plaintext.

## Migrations & clients

- Migrations are hand-written ordered SQL with a small in-house runner — no migration framework
  (ADR 0007). Each store owns its array; a schema change goes in all four. Append new `{ id, sql }`
  entries; never edit a shipped one. See the `add-migration` skill.
- Export small, typed client factories; read connection settings from env (see `.env.example`).
- No DOM/browser imports in store code — these are server/Node packages. `@uptimizr/db/query` and
  `@uptimizr/db/summary` are the browser-safe subpaths.

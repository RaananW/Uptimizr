---
description: Database conventions — ClickHouse (events) and Postgres (metadata).
applyTo: "oss/packages/db/**"
---

# `@uptimizr/db` — ClickHouse + Postgres

Typed clients and migrations for the two-store design (ADR 0002).

## ClickHouse (event store)

- Use the official `@clickhouse/client`.
- Events table: partition by date (`toYYYYMMDD(ts)` or `toDate(ts)`), `ORDER BY (project_id,
event_type, ts)`. Choose `MergeTree` family appropriate to the access pattern.
- Prefer **async inserts** / batching for ingestion throughput; expose a batched insert helper.
- Store vectors compactly (e.g. `Array(Float32)` or separate `Float32` columns), not JSON blobs,
  for fields that are queried/aggregated.
- Raw per-session event storage (for replay) is gated by `ENABLE_RAW_SESSION_RETENTION`
  (ADR 0003). Provide an ordered read by `session_id` for the timeline endpoint.
- Aggregations are query-time by default. Phase 2 adds ClickHouse **materialized views** for the
  common daily rollups (`perf_daily`, `events_daily`) to keep dashboards fast at volume; query-time
  aggregation remains the source of truth and the rollups are append-only migrations. Read rollups
  with the `-Merge`/`sum` helpers in `clickhouse/queries.ts`.

## Postgres (metadata)

- Holds `projects` and `api_keys` in v1 (orgs/users/billing arrive in Phase 2).
- Use a typed client/ORM consistently across the package; keep migrations versioned and
  additive (forward-only, idempotent via `IF NOT EXISTS` — see ADR 0007).
- API keys: store only hashes, never plaintext.

## Migrations & clients

- Migrations are hand-written ordered SQL with a small in-house runner — no migration
  framework (ADR 0007). Append new `{ id, sql }` entries; never edit a shipped one.
- Keep ClickHouse and Postgres migrations in clearly separated, ordered files.
- Export small, typed client factories; read connection settings from env (see `.env.example`).
- No DOM/browser imports — this package is server/Node only.

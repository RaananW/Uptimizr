# ADR 0007: Hand-written SQL migrations (no migration framework)

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** Project owner, engineering

## Context

`@uptimizr/db` manages schema for **two** stores (ADR 0002):

- **ClickHouse** — the event store, whose `events` table depends on engine-specific DDL
  (`MergeTree`, `PARTITION BY toYYYYMMDD(ts)`, `ORDER BY (project_id, event_type, ts)`,
  `LowCardinality(String)`, `Array(Float32)`). These choices directly determine
  query/heatmap performance.
- **Postgres** — relational metadata (`projects`, `api_keys`).

The collector is Apache-2.0 and meant to be easily self-hosted and audited, so dependency and
supply-chain footprint matter. We also do not use an ORM at runtime: ClickHouse aggregations are
hand-written parameterized `QuerySpec` builders, because the queries are bespoke OLAP.

The question: should we adopt a migration framework (e.g. Prisma, Drizzle, TypeORM,
`node-pg-migrate`) instead of running our own migrations?

## Decision

Use **hand-written, ordered SQL migrations** with a tiny in-house runner, rather than a
migration framework, for Phase 1.

- Migrations are ordered arrays of `{ id, sql }` per store (`CLICKHOUSE_MIGRATIONS`,
  `POSTGRES_MIGRATIONS`), applied in order by `migrateClickHouse` / `migratePostgres`.
- Migrations are **forward-only and additive**, made idempotent with `IF NOT EXISTS` so the
  runner is safe to re-run on every boot.
- A shipped migration is never edited; new schema is a new appended entry.

This is a Phase 1 decision sized to a one-table ClickHouse schema and a two-table Postgres
schema. It is explicitly revisited when the constraints below are hit.

## Consequences

### Positive

- **One mechanism covers both stores.** No mainstream framework manages ClickHouse, so a
  framework would solve only the Postgres half and still require a second tool for ClickHouse.
- **Full control of performance-critical DDL.** ClickHouse engine/partition/order clauses are
  written explicitly rather than squeezed through an ORM schema DSL (which would fall back to raw
  SQL for exactly these parts anyway).
- **Minimal footprint.** No codegen step, no query-engine binary, near-zero added dependency and
  supply-chain surface — important for a self-hostable OSS component.
- **Consistent with the no-ORM runtime.** Migrations and queries are both plain, reviewable SQL.

### Negative / trade-offs

- **No applied-migrations ledger.** There is no `schema_migrations` tracking table; correctness
  relies on every migration being additive and idempotent.
- **No down/rollback, no checksum/drift detection.** Destructive or `ALTER`-style changes cannot
  be made safely idempotent with `IF NOT EXISTS` and are not yet supported.
- **We own the runner.** Any versioning/ordering guarantees a framework would provide are our
  responsibility.

Note: ADR 0002's instruction note describing Postgres migrations as "reversible" is superseded by
this ADR — Phase 1 migrations are forward-only.

## Revisit triggers

Adopt a migrations **ledger** (a `schema_migrations` table tracking applied `id`s), and possibly
a Postgres-only framework such as `node-pg-migrate` or Drizzle, when **any** of these occur:

- The first **non-additive** change (an `ALTER`/`DROP`/backfill that `IF NOT EXISTS` cannot make
  idempotent).
- A need for **rollback** or **drift detection**.
- Significant growth of the Postgres metadata model.

In all cases, **keep ClickHouse migrations hand-written** — no framework manages it well.

## Alternatives considered

- **Prisma** — strong Postgres DX, but no ClickHouse support, plus a Rust query engine and
  codegen step pulled in only for the Postgres half while we don't use its client at runtime.
- **Drizzle / `node-pg-migrate`** — lighter and Postgres-appropriate; still Postgres-only, so
  ClickHouse stays hand-rolled. A reasonable option for Postgres once a ledger is needed.
- **TypeORM / Sequelize** — heavier ORMs, same one-store limitation, more surface than warranted
  for a two-table Phase 1 schema.

# @uptimizr/db-postgres

Optional **single-tenant PostgreSQL store** for the Uptimizr collector — for
self-hosters who already run Postgres and want a familiar, multi-writer
relational backend instead of the default single-file DuckDB store (ADR 0020,
issue #84).

It is a **re-home + dialect emitter, not a rewrite**: every analytics
aggregation is authored once in [`@uptimizr/db`](../db) against the
dialect-agnostic query layer, and this package renders them to Postgres SQL via
the shared `postgresDialect`, plus a pooled [`pg`](https://node-postgres.com)
client, schema/migrations, and metadata helpers that satisfy the same
`CollectorStore` contract as DuckDB and ClickHouse.

## When to use it

Stay on the default DuckDB store unless you hit its single read-write process
ceiling. Choose Postgres when you want **several collector instances** sharing
one store, or when Postgres is simply the database your team already operates
(managed Postgres, RDS, Cloud SQL, Supabase, Neon, …). Choose
[`@uptimizr/db-clickhouse`](../db-clickhouse) instead for high-volume ingestion
and large historical ranges.

## Usage

Select it via the collector's `COLLECTOR_STORE` env var:

```bash
COLLECTOR_STORE=postgres \
POSTGRES_URL=postgresql://uptimizr:uptimizr@localhost:5432/uptimizr \
  pnpm --filter @uptimizr/collector-server start
```

| Variable                           | Purpose                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `POSTGRES_URL` (or `DATABASE_URL`) | libpq connection URI (`?sslmode=require` etc. apply). The database must already exist. |
| `POSTGRES_SCHEMA`                  | Schema the store's tables live in (default `public`; created on first boot).           |
| `POSTGRES_POOL_MAX`                | Maximum pooled connections per collector process (default `10`).                       |

A local Postgres is available via [`infra/docker`](../../../infra/docker)
(`pnpm stack:up` starts a `postgres:16` service). The schema is migrated on store
creation — migrations are idempotent, forward-only (ADR 0007) and serialized
behind an advisory lock, so several instances may boot concurrently against one
database. Postgres 14+ is supported (tested against 16).

## Scope

- **Single-tenant only** — no `org_id`, no tenant isolation. The multi-writer
  rollups and scale tuning remain the scale tier; this package is the
  single-instance relational adapter.
- No stubbed features — the full analytics surface (heatmaps, perf percentiles,
  click↔gaze rays, funnels) returns results identical to DuckDB on the
  cross-engine parity fixtures.

## Row-store fit gaps and how they are closed

| Gap                            | Postgres rendering                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `ASOF JOIN`                 | `Dialect.asofJoin(spec)` renders `[INNER\|LEFT] JOIN LATERAL (SELECT * FROM <right> WHERE keys… AND ts <= left.ts ORDER BY ts DESC LIMIT 1) ON TRUE` (`renderNearestRowJoin`). Same rows as a native ASOF join; one indexed lookup per left row instead of a single merge pass — fine at self-host scale, slower than DuckDB/ClickHouse on very large sessions. The `(project_id, session_id, ts)` index exists for exactly this. |
| No MergeTree rollups           | `perf_daily` / `events_daily` are plain views recomputed at query time; the `-Merge` combinators reduce to `sum`/`avg`/`percentile_cont` pass-throughs, as on DuckDB.                                                                                                                                                                                                                                                             |
| 1-indexed arrays               | Same convention as DuckDB and ClickHouse, so `position[1]` in the shared SQL is untouched; `arrayLength` → `cardinality`, `vectorNorm` → `sqrt(sum(v*v))` over `unnest`.                                                                                                                                                                                                                                                          |
| `quantile` / `avgIf` / `any`   | `percentile_cont(q) WITHIN GROUP (ORDER BY …)`, `avg(…) FILTER (WHERE …)`, `min(…)` (a deterministic "any" that also works before PG 16's `any_value`).                                                                                                                                                                                                                                                                           |
| JSON extraction, no `TRY_CAST` | `payload` is `jsonb`; `jsonText` → `#>>`, `jsonInt`/`jsonFloat` regex-guard the cast so absent / non-numeric keys yield NULL exactly like DuckDB's `TRY_CAST`. The payload round-trips replay-complete (`jsonb` is value-lossless for JSON numbers/strings; key order is irrelevant).                                                                                                                                             |
| Parameters                     | The dialect emits named `$name::type` placeholders (explicit casts, so Postgres never infers a parameter type); `runPostgresQuery` rewrites them to positional `$1…$n` with the shared `toPositionalParams`.                                                                                                                                                                                                                      |
| `count()` / `length(array)`    | Not valid Postgres — the shared SQL now uses `count(*)` and `Dialect.arrayLength`.                                                                                                                                                                                                                                                                                                                                                |
| Timestamps                     | `timestamp` (without time zone) holding wall-clock UTC, bound as naive-UTC literals; epoch extraction, `::date` and bucketing are session-`TimeZone`-independent and identical to the other engines.                                                                                                                                                                                                                              |

### Documented divergences

None on the parity fixtures: all 68 `PARITY_CASES` match the golden and DuckDB,
and every `build*` aggregation (69, across base / filtered / spatial option
variants) matches DuckDB row-for-row. Two engine behaviours differ only where
the query layer already declares them unspecified: ties on the right-hand
timestamp of an ASOF join are broken arbitrarily on every engine, and
`anyValue` picks an arbitrary group member on DuckDB/ClickHouse but the minimum
on Postgres (callers only use it on values constant within the group).

## Reusable relational helpers (for the SQL Server port, #85)

The engine-neutral pieces live in `@uptimizr/db` (`src/query/relational.ts`) and
are re-exported from its root:

- `renderNearestRowJoin(spec, tokens)` — the ASOF emulation; SQL Server reuses
  it with `{ inner: "CROSS APPLY", left: "OUTER APPLY", onTrue: "",
selectPrefix: "SELECT TOP 1", selectSuffix: "" }`.
- `renderNativeAsofJoin(spec)` — the DuckDB / ClickHouse rendering.
- `toPositionalParams(sql, params, render)` — named → positional rewriting
  (`@p1…` for `mssql`).
- The query-time rollup strategy (plain views named `perf_daily` /
  `events_daily` with `*_state` columns) and the `jsonb`-style regex-guarded
  numeric extraction pattern are documented in `migrations.ts` and
  `postgresDialect.ts` respectively and port 1:1.

## Layout

| File               | Responsibility                                                          |
| ------------------ | ----------------------------------------------------------------------- |
| `client.ts`        | Pooled `pg` wrapper (UTC session, schema search path, plain-JS values). |
| `migrations.ts`    | Forward-only DDL (events, node_samples, metadata, query-time views).    |
| `events.ts`        | Batched multi-row inserts + replay-complete session reads.              |
| `projects.ts`      | Project + API-key metadata (SHA-256 hashes).                            |
| `sceneRegistry.ts` | Per-`(project, scene)` representation upserts/reads (`ON CONFLICT`).    |
| `queries.ts`       | `runPostgresQuery` — executes a rendered `QuerySpec`.                   |

The `CollectorStore` itself is assembled from these building blocks in the
collector server (`oss/apps/collector-server/src/postgresStore.ts`,
`createPostgresStore`), mirroring the DuckDB and ClickHouse stores — this
package stays a store-agnostic toolkit.

## Tests

- `dialect.test.ts` — pure unit checks (no server).
- `postgresParity.test.ts` / `postgresStore.test.ts` — live suites that probe
  `POSTGRES_URL` (or `DATABASE_URL`) first and **skip when no server is
  reachable**, so the default `pnpm test` stays Docker-free. They use throwaway
  schemas that are dropped on teardown.

Licensed Apache-2.0.

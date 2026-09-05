# @uptimizr/db-mssql

Optional **single-tenant Microsoft SQL Server store** for the Uptimizr collector
— for self-hosters standardized on SQL Server / Azure SQL who want a familiar,
multi-writer relational backend instead of the default single-file DuckDB store
(ADR 0020, issue #85).

It is a **re-home + dialect emitter, not a rewrite**: every analytics
aggregation is authored once in [`@uptimizr/db`](../db) against the
dialect-agnostic query layer, and this package renders them to T-SQL via the
shared `mssqlDialect`, plus a pooled [`mssql`](https://github.com/tediousjs/node-mssql)
(tedious) client, schema/migrations, and metadata helpers that satisfy the same
`CollectorStore` contract as DuckDB, ClickHouse and Postgres.

## When to use it

Stay on the default DuckDB store unless you hit its single read-write process
ceiling. Choose SQL Server when it is the database your team **already
operates** (on-premises SQL Server, Azure SQL Database / Managed Instance) and
you want **several collector instances** sharing one store. Choose
[`@uptimizr/db-postgres`](../db-postgres) if you run Postgres, or
[`@uptimizr/db-clickhouse`](../db-clickhouse) for high-volume ingestion and
large historical ranges — SQL Server is the heaviest relational port (see the
fit gaps below) and the slowest of the four on the spatial heatmaps.

## Usage

Select it via the collector's `COLLECTOR_STORE` env var:

```bash
COLLECTOR_STORE=mssql \
MSSQL_URL="Server=localhost,1433;Database=uptimizr;User Id=sa;Password=Uptimizr!Local1;Encrypt=true;TrustServerCertificate=true" \
  pnpm --filter @uptimizr/collector-server start
```

| Variable                                           | Purpose                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `MSSQL_URL`                                        | ADO.NET-style connection string (`Server=host,port;Database=…;User Id=…;Password=…;Encrypt=…`). Wins when set.      |
| `MSSQL_SERVER` / `MSSQL_PORT`                      | Host / port when `MSSQL_URL` is unset (default `localhost` / `1433`).                                               |
| `MSSQL_DATABASE`                                   | Database (default `uptimizr`). Created on first boot when the login has `CREATE ANY DATABASE`.                      |
| `MSSQL_USER` / `MSSQL_PASSWORD`                    | SQL login (default `sa`; `MSSQL_SA_PASSWORD` — the variable the SQL Server image reads — is the password fallback). |
| `MSSQL_ENCRYPT` / `MSSQL_TRUST_SERVER_CERTIFICATE` | TLS on (default `true`, as Azure SQL requires) / trust a self-signed certificate (default `false`).                 |
| `MSSQL_POOL_MAX`                                   | Maximum pooled connections per collector process (default `10`).                                                    |

A local SQL Server is available via [`infra/docker`](../../../infra/docker)
(`pnpm stack:up` starts a `mcr.microsoft.com/mssql/server:2022-latest` service).
The schema is migrated on store creation — migrations are idempotent,
forward-only (ADR 0007) and serialized behind an application lock
(`sp_getapplock`), so several instances may boot concurrently against one
database. **SQL Server 2022 (16.x) or Azure SQL** is required (`GREATEST` /
`LEAST`; the rest is 2016+).

## Scope

- **Single-tenant only** — no `org_id`, no tenant isolation. The multi-writer
  rollups and scale tuning remain the scale tier; this package is the
  single-instance relational adapter.
- No stubbed features — the full analytics surface (heatmaps, perf percentiles,
  click↔gaze rays, funnels) returns results identical to DuckDB on the
  cross-engine parity fixtures.

## Fit gaps and how they are closed

SQL Server lacks three things the shared SQL takes for granted, plus a few
syntax differences. Everything below lives in `mssqlDialect` / `toTsql`
(`@uptimizr/db`, `src/query/mssqlDialect.ts`) and in this package's migrations.

| Gap                          | SQL Server rendering                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No array type**            | Vector columns (`position`, `direction`, `hit_point`, `ray_origin`, `ray_direction`, `screen`, `rotation`, `scale`) are JSON number arrays (`'[x,y,z]'`, `nvarchar`). The shared SQL's inline `position[1]` is rewritten at execution time to `TRY_CONVERT(float, JSON_VALUE(position, '$[0]'))` (`toTsql`); `vectorNorm` sums the squared JSON elements and `arrayLength` counts them — all in one place (`mssqlVectorElement`). Replay reads parse the JSON back. |
| No `ASOF JOIN`               | `Dialect.asofJoin(spec)` renders the shared nearest-row emulation (`renderNearestRowJoin`) as `CROSS APPLY` / `OUTER APPLY (SELECT TOP 1 * FROM <right> WHERE keys… AND ts <= left.ts ORDER BY ts DESC)`. Same rows as a native ASOF join; one indexed lookup per left row backed by the `(project_id, session_id, ts)` index.                                                                                                                                      |
| No aggregate percentile      | `PERCENTILE_CONT` is window-only in T-SQL, so it cannot sit in a `GROUP BY` select list. `quantile` packs each group's values with `STRING_AGG` (a real aggregate) and the migration-created scalar function `dbo.uptimizr_quantile` sorts them and applies the type-7 interpolation DuckDB's `quantile_cont` / Postgres' `percentile_cont` use — exact, O(n log n) per group.                                                                                      |
| No MergeTree rollups         | `perf_daily` / `events_daily` are plain views recomputed at query time; the `-Merge` combinators reduce to `sum` / `avg` / quantile pass-throughs, as on DuckDB.                                                                                                                                                                                                                                                                                                    |
| `LIMIT`, `GROUP BY <alias>`  | Not T-SQL. `toTsql` rewrites `LIMIT n` to `OFFSET 0 ROWS FETCH NEXT n ROWS ONLY` and replaces output-column aliases in `GROUP BY` with their select-list expressions (a small block-scoped scanner; `atan2` → `ATN2` too).                                                                                                                                                                                                                                          |
| `avgIf` / `anyValue` / `avg` | `AVG(CASE WHEN … THEN CAST(… AS float) END)`, `MIN(…)`. Integer `AVG` truncates in T-SQL, so every averaged input is `float` (the promoted columns already are; `epochMs` returns `float`, exact for epoch milliseconds).                                                                                                                                                                                                                                           |
| JSON extraction              | `payload` is JSON text; `jsonText` → `JSON_VALUE(…) COLLATE Latin1_General_100_BIN2`, `jsonInt` / `jsonFloat` → `TRY_CONVERT` (NULL for absent / non-numeric keys, exactly like DuckDB's `TRY_CAST`). The payload round-trips replay-complete.                                                                                                                                                                                                                      |
| Case-insensitive default     | Every string column and JSON extraction uses the binary collation `Latin1_General_100_BIN2`, so `=`, `GROUP BY` and ordering are case-sensitive / code-point ordered like DuckDB and Postgres.                                                                                                                                                                                                                                                                      |
| Parameters, driver values    | The dialect emits named `$name` placeholders (cast in place for `f64` / `timestamp` / `date`); `runMssqlQuery` rewrites them to `@p1…@pn` with the shared `toPositionalParams`. The client turns `bigint` strings into numbers and `datetime2` / `date` values into naive-UTC text, so rows match DuckDB's.                                                                                                                                                         |
| Timestamps                   | `datetime2(3)` holding wall-clock UTC, bound as ISO-8601 `T`-separated literals (language / `DATEFORMAT`-independent); epoch extraction via `DATEDIFF_BIG`, `CAST(… AS date)` and bucketing are identical to the other engines.                                                                                                                                                                                                                                     |

### Performance trade-off

Correctness is identical; cost is not. Compared with DuckDB / ClickHouse /
Postgres, the spatial heatmaps parse JSON per row instead of reading a native
array, ASOF joins are per-row `APPLY` lookups instead of a merge pass, and
percentiles pack and sort each group's values in a scalar function. All of this
is fine at the single-tenant scale this store targets; for high-volume ranges
pick ClickHouse.

### Documented divergences

None on the parity fixtures: all 68 `PARITY_CASES` match the golden and DuckDB,
and every `build*` aggregation (69, across base / filtered / spatial option
variants) matches DuckDB row-for-row. Behaviours differ only where the query
layer already declares them unspecified: ties on the right-hand timestamp of an
ASOF join are broken arbitrarily on every engine; `anyValue` picks an arbitrary
group member on DuckDB/ClickHouse but the minimum here; `NULL` sorts first in
ascending `ORDER BY` on SQL Server (last on DuckDB/Postgres), which only shows
when a `limit` truncates a result set ordered by a nullable column; and decimal
arithmetic on numeric literals keeps six fractional digits (within the parity
tolerance).

## Layout

| File               | Responsibility                                                                   |
| ------------------ | -------------------------------------------------------------------------------- |
| `client.ts`        | Pooled `mssql` wrapper (UTC, plain-JS values, database bootstrap / teardown).    |
| `migrations.ts`    | Forward-only DDL (quantile helper, events, node_samples, metadata, views).       |
| `events.ts`        | Batched multi-row inserts (JSON vectors) + replay-complete session reads.        |
| `projects.ts`      | Project + API-key metadata (SHA-256 hashes).                                     |
| `sceneRegistry.ts` | Per-`(project, scene)` representation upserts/reads (`MERGE … HOLDLOCK`).        |
| `queries.ts`       | `runMssqlQuery` — `toTsql` + positional params, executes a rendered `QuerySpec`. |

The `CollectorStore` itself is assembled from these building blocks in the
collector server (`oss/apps/collector-server/src/mssqlStore.ts`,
`createMssqlStore`), mirroring the DuckDB, ClickHouse and Postgres stores —
this package stays a store-agnostic toolkit.

## Tests

- `dialect.test.ts` — pure unit checks (no server): dialect fragments, the
  `toTsql` rewrites, and that every parity query renders free of the constructs
  T-SQL rejects.
- `mssqlParity.test.ts` / `mssqlStore.test.ts` — live suites that probe the
  server behind `MSSQL_URL` (or the `MSSQL_*` variables) first and **skip when
  no server is reachable**, so the default `pnpm test` stays Docker-free. They
  create throwaway databases (`uptimizr_mssql_parity_test`,
  `uptimizr_mssql_store_test`) and drop them on teardown. Set
  `MSSQL_PARITY_REQUIRED=1` to fail instead of skipping (the CI job does).

Licensed Apache-2.0.

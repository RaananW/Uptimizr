---
"@uptimizr/db": minor
---

Add `postgresDialect` (+ `PostgresSettings` via `readDbSettings().postgres`, read from
`POSTGRES_URL` / `DATABASE_URL`, `POSTGRES_SCHEMA`, `POSTGRES_POOL_MAX`) and the engine-neutral
relational helpers (`renderNearestRowJoin`, `renderNativeAsofJoin`, `toPositionalParams`) that
row-store dialects share (#84; the SQL Server port reuses them).

`Dialect` gains `arrayLength(expr)` and a structured `asofJoin(spec)`, which **replaces** the
`asofInnerJoin` / `asofLeftJoin` string introducers so engines without a native `ASOF JOIN` can
emulate it. The shared aggregations now emit portable `count(*)` / `arrayLength` — DuckDB and
ClickHouse output is unchanged (parity suites pass as before).

---
"@uptimizr/metrics": minor
"@uptimizr/db": minor
"@uptimizr/db-clickhouse": minor
"@uptimizr/db-postgres": minor
"@uptimizr/db-mssql": minor
"@uptimizr/collector-server": minor
---

Coerce numeric columns at every store's edge, so the collector always emits numbers (ADR 0051 §2).

`@uptimizr/db` gains `coerceRows(metric, rows)`, driven by the metric registry's `row` schema, plus
`numericColumns` / `numericColumnsOfMetric`; `@uptimizr/metrics` gains the `METRIC_BY_BUILDER`
reverse lookup behind `metricForBuilder` (pure registry data, so it lives with the registry). Every
`build*` aggregation now tags its `QuerySpec` with the registry metric id (`QuerySpec.metric`), and
`runDuckdbQuery`, `runClickhouseQuery`, `runPostgresQuery` and `runMssqlQuery` each apply the
coercion at the single point rows leave their driver — so a 64-bit integer or decimal that
ClickHouse renders as `"42"` over HTTP, or an `int8` that `pg` hands back as a string, reaches every
consumer as a number. `null` is preserved: an aggregate over an empty set means "no samples", never
`0`. A value that is neither a number, `null`, nor a finite numeric string throws under a test
runner and is left untouched with a one-per-column warning in production.

Because the coercion now happens at the edge, the registry's numeric columns are strict `z.number()`
rather than `z.coerce.number()`, and the collector's query routes carry those schemas as Fastify 200
response schemas. Tightening the schemas exposed that nine perf/resource metrics can legitimately
return `null` — SQL aggregates are NULL over an empty set, and a single-row summary is still
returned when the range matched nothing — so `perf_summary`, `perf_distribution`,
`frame_time_percentiles`, `jank_rate`, `perf_churn`, `render_scale_truth`, `resource_summary`,
`resource_percentiles` and `dead_clicks` now declare those columns nullable. Previously
`z.coerce.number()` silently reported them as `0`; consumers that treated `0` as "measured zero"
should now read `null` as "no data". Cross-engine parity asserts `typeof === "number"` for every
registry-numeric column on DuckDB, ClickHouse, Postgres and SQL Server.

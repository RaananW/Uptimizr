# @uptimizr/metrics

## 0.1.0

### Minor Changes

- fa489c1: New package: `@uptimizr/metrics`, the semantic metric registry (ADR 0051 §1). One
  `MetricDefinition` per Uptimizr analytics metric — id, title, agent-facing description, collector
  endpoint, result grain, group-by dimensions, accepted filters, the output row schema (Zod),
  per-column units and semantics, row limits, interpretation, caveats, source capture channels,
  related metrics and comparison semantics — plus the closed `DimensionId` / `FilterId` vocabularies,
  the `FILTER_TARGETS` glossary and the `AGGREGATION_BUILDER_NAMES` list.

  The registry previously lived in `@uptimizr/db` on a (never-released) `@uptimizr/db/registry`
  subpath. A pure subpath was not enough: a package manager installs a package's dependencies, not
  the subset a subpath reaches, so every consumer of the registry also downloaded `@duckdb/node-api`
  — a ~37 MB native binding a browser bundle or an `npx` MCP client can never use. This package's
  only runtime dependencies are `zod` and `@uptimizr/schema`; it performs no I/O, touches no `node:`
  built-in and holds no reference to a store or a dialect.

  Every export keeps the name it had.

- ee1b7c7: Coerce numeric columns at every store's edge, so the collector always emits numbers (ADR 0051 §2).

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

### Patch Changes

- Updated dependencies [2f1a753]
  - @uptimizr/schema@1.1.0

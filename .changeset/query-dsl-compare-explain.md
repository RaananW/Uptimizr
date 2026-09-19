---
"@uptimizr/schema": minor
"@uptimizr/metrics": minor
"@uptimizr/db": minor
"@uptimizr/db-postgres": minor
"@uptimizr/db-mssql": minor
"@uptimizr/db-clickhouse": minor
"@uptimizr/collector-server": minor
"@uptimizr/agent-core": minor
"@uptimizr/mcp": minor
---

**Query DSL stage 2** (ADR 0051 §3, #304): `compare`, `explain`, runnable drill hints, `order`,
`segment` and a **generic group-by tier** — the four fields the v1 grammar published and answered
with `400 … not supported yet` now execute.

**The grain is registry data.** `MetricDefinition` gains a required `grainDimensions` (what one row
is keyed by, read through `nativeDimensions`) and an optional `genericGroupBy`. The grain used to be
derived from `row.shape` at call time, which was correct but left the registry unable to distinguish
"this metric cannot be grouped by that" from "it can, through another compiler". The old derivation
survives as the gate on the declaration.

**A second compiler, not a second SQL path.** Seven metrics whose measure is a portable count or sum
over promoted columns — `event_counts`, `top_meshes`, `mesh_sources`, `mesh_interaction_kinds`,
`interaction_sources`, `top_input_actions`, `camera_gestures` — declare `genericGroupBy` and can be
recomputed at any grain they declare by one shared, dialect-authored builder. Everything variable in
its SQL comes from registry data; every caller-supplied value is a bound parameter. Spatial and
percentile metrics have no generic tier and keep refusing a non-grain `dimensions` by name. Six
`dsl:generic*` parity cases execute the generic SQL on DuckDB, Postgres, SQL Server and ClickHouse
against the same hand-verified goldens.

**`compare`** runs the same validated spec twice — the comparison's `range`, or its `segment`,
substituted — and joins the two results in TypeScript on the dimension key, so every row is
`{ key, label, current, previous, delta, deltaPct }` and a key present on one side only is still a
row. `significance` is attached only where the registry justifies it: a pooled two-proportion _z_
with Wilson intervals when the measure is a count and both windows clear the metric's `minSample`,
Welch's _t_ over a `bucket`-grain metric's per-bucket values, and **absent** for a mean-shaped
measure, with a caveat saying why. `format=summary` digests it into ranked movers with a templated
reading.

**`explain: true`** answers with the plan instead of the rows: the tier, the store's dialect, the
rendered SQL with its parameters left unbound, `params` by name and logical type (never value),
`rowsScanned`, and `warnings` for a capture channel that produced nothing in the window, a sample
below the metric's own minimum, a spatial result with no proxy or regions to name hotspots after,
and truncation by `limit`. Stores gain one method, `describeMetric`, which compiles without running.

**Drill hints are runnable.** Every ranked summary row now carries `drillQuery` — the whole query,
narrowed to that row — using `filters` where the metric has one and `segment` where it has not, so
following a drill-down is a copy-paste rather than a reconstruction.

**`order`** is honoured in SQL on the generic tier and applied to a delegated ranked result
afterwards, with a caveat when the builder's own row cap had already chosen which rows exist.
`filters.event` (an ADR 0038 predicate, applied as a cohort of sessions) and `filters.device`
(`os` / `browser` on `session_start`) are generic-tier only. `queryDimensionIdSchema` now admits
`camelCase`, so `cameraMode` is nameable as a dimension.

The `query` tool's description gains one line each for `compare`, `explain` and `drillQuery` — the
three things a model otherwise does badly in prose.

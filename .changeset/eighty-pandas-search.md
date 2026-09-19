---
"@uptimizr/metrics": minor
"@uptimizr/db": minor
"@uptimizr/collector-server": minor
"@uptimizr/agent-core": minor
"@uptimizr/mcp": minor
---

Insight primitive: `anomalies` (ADR 0051 §4)

A third registry metric under `/api/v1/insights/` — **`insight_anomalies`**
(`GET /api/v1/insights/anomalies`) — answers the question `baseline` and `movers`
cannot: _when_ did one metric go wrong, and what inside it accounts for that.

It walks a comparable metric's day- or hour-bucketed series and returns only the
buckets that do not belong in it:

- **`spike` / `drop`** — one bucket more than `sensitivity` (default 3, range 1–10)
  standard deviations from a rolling median and MAD over the trailing window (14
  buckets at `day` grain, 168 at `hour`), with the bucket itself excluded so a large
  enough departure cannot hide inside its own expectation.
- **`shift`** — the bucket at which the level moved and _stayed_ moved, from a
  two-sided CUSUM over the same series. This is the shape a release regression
  actually has — never more than a MAD or two off on any single day — and no
  per-bucket threshold can see it.
- **`contributor`** — where the metric declares one dimension it can be split by
  (a mesh, a source, an input action, an event type, a scene), the anomalous window
  is re-read grouped by that column and the row names the value holding the largest
  `share` of the excess.

Rows are `{ metric, scene, bucketStart, value, expected, z, kind, contributor,
sampleSize }`, oldest first. Like the other two primitives it is an ordinary
registry entry, so it arrives as the `insight_anomalies` agent and MCP tool, as an
OpenAPI operation, in the capabilities resource and with `format=table | summary`
support automatically.

Cost is bounded by construction: one grouped scan builds the series and attribution
costs **at most three** more per request, however many buckets are anomalous —
adjacent findings share a window and only the three most extreme are re-read.

`z` is reported in standard deviations (the MAD rescaled by 1.4826) so that
`sensitivity` is a calibrated dial; `insight_movers` continues to report the same
ratio unscaled because it ranks rather than thresholds, and the two columns are
documented as differing by that constant.

In `@uptimizr/db`: `buildMetricBuckets` gains an optional `groupBy` that adds one
promoted column — taken from the measure catalog's new `splitBy`, a compile-time
union, never request input — to the grouped scan. New `metricBuckets:split*` parity
cases cover that shape on DuckDB, ClickHouse, Postgres and SQL Server. The detector
itself is pure TypeScript in `src/insights/anomalies.ts` and `src/insights/changepoint.ts`.

The `weekly_scene_health` MCP prompt now calls `insight_anomalies` after
`insight_movers`, so a weekly report names the day something changed instead of
saying "recently".

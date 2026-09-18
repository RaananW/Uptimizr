---
"@uptimizr/metrics": minor
"@uptimizr/db": minor
"@uptimizr/collector-server": minor
"@uptimizr/agent-core": minor
"@uptimizr/mcp": minor
---

Insight primitives: `baseline` and `movers` (ADR 0051 §4)

Two new registry metrics under `/api/v1/insights/` answer the questions that were
previously re-derived from raw rows on every turn:

- **`insight_baseline`** (`GET /api/v1/insights/baseline`) — what is normal for one
  metric in one scene. Buckets a comparable metric's headline column by day or hour
  over a trailing window (default 28 days) and reduces the series to its centre
  (`mean`, `median`), its ordinary spread (`mad`, `p10`, `p90`) and its drift
  (`slope`).
- **`insight_movers`** (`GET /api/v1/insights/movers`) — what changed. Compares the
  current range with a reference range (the previous equal window by default) for
  every comparable metric in scope and ranks the differences by a robust z-score —
  the change divided by the median absolute deviation of the reference series — so a
  metric that always swings has to move much further than a steady one before it is
  called a mover. A delta below the metric's `minSample` is reported with
  `aboveMinSample: false` and sorted below every gated mover rather than dropped.

Both are ordinary registry entries, so they arrive as the `insight_baseline` /
`insight_movers` agent and MCP tools, in the generated OpenAPI document and in the
capabilities resource automatically, and they accept `format=table | summary`.

Statistics run in **pure TypeScript** over one portable, dialect-authored per-bucket
query (`buildMetricBuckets`, parity-tested on DuckDB, ClickHouse, Postgres and SQL
Server), so an insight cannot change when a self-hoster switches storage engine.
Only `comparable` metrics with a faithful per-bucket form participate; one without
returns `400` naming every id that does. A `movers` request scans at most 24 metrics.

Also in `@uptimizr/metrics`: a registry entry may now be **derived** — computed in
TypeScript over other metrics rather than by a `build*` aggregation — alongside the
existing aggregation and resource kinds. Use the new `isAggregateMetric()` predicate
where the question is "is this served over a querystring?"; `isResourceMetric()` and
the new `isDerivedMetric()` distinguish the two builder-less kinds.

The `weekly_scene_health` MCP prompt now leads with `insight_movers` and
`insight_baseline` instead of surveying each metric by hand.

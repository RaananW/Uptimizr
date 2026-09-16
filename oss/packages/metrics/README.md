# @uptimizr/metrics

> The **semantic metric registry** for Uptimizr: one machine-readable definition per analytics
> metric — what it measures, the collector endpoint that serves it, the filters it accepts, the
> Zod schema of one row, per-column units and semantics, row limits, how to read the result and
> what not to trust.

Everything that used to restate the query surface by hand is **derived** from this package: the
agent tool catalog in [`@uptimizr/agent-core`](../agent-core), the `uptimizr://capabilities`
resource and tool output schemas in [`@uptimizr/mcp`](../mcp), the collector's
`GET /api/v1/openapi.json` document, and the endpoint/tool tables in the docs. Coverage therefore
cannot drift: CI fails when an aggregation has no registry entry, when a row schema does not match
real query output, or when an endpoint's querystring keys diverge from its declared filters.

**Dependency-free and browser-safe.** The only runtime dependencies are `zod` and
`@uptimizr/schema` (imported type-only). No `node:` built-in, no DOM, no database driver — so a
browser bundle, an `npx` MCP client or an edge function can read the registry without pulling in
[`@uptimizr/db`](../db) and its ~37 MB `@duckdb/node-api` native binding.

## Install

```bash
pnpm add @uptimizr/metrics
```

## Quick start

```ts
import { allMetrics, getMetric, METRIC_IDS } from "@uptimizr/metrics";

METRIC_IDS.length; // 71 metrics (69 aggregations + 2 store resources)

const metric = getMetric("top_meshes");
metric?.title; // "Most-interacted meshes"
metric?.endpoint?.path; // "/api/v1/meshes/top"
metric?.filters; // ["since", "until", "bins", "limit", "session"]
metric?.row; // z.ZodObject — the shape of one row
metric?.columns.count?.unit; // "count"
metric?.limits.maxRows; // the hard cap no consumer may exceed

// Everything an agent may call, grouped the way the docs group it:
const byCategory = Object.groupBy(allMetrics(), (m) => m.category);
```

## What a `MetricDefinition` carries

| Field                   | Meaning                                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                    | Stable snake_case id. Also the DSL metric name and the **agent tool name**.                                                                                           |
| `title`, `description`  | Agent-facing prose: what it measures and what one row is.                                                                                                             |
| `builder`               | The `build*` aggregation in `@uptimizr/db` that computes it. Absent for the two **resource** entries (`session_meta`, `scene_representation`), which are store reads. |
| `endpoint`              | `{ method, path, pathParams }` — the canned collector route, when one exists.                                                                                         |
| `grain`                 | What one row represents (`project`, `scene`, `session`, `mesh`, `bin`, `voxel`, `bucket`, `row`).                                                                     |
| `dimensions`            | The `DimensionId`s the rows are keyed by. Closed vocabulary.                                                                                                          |
| `filters`               | The `FilterId`s the endpoint accepts — exactly its Zod querystring keys.                                                                                              |
| `row`                   | `z.ZodObject` for one row: the source for OpenAPI, tool output schemas and numeric coercion.                                                                          |
| `columns`               | Per-column `{ description, unit, measure, label, rateOf }`.                                                                                                           |
| `limits`                | `{ maxRows, maxSummaryRows }` — no consumer can ask for an unbounded payload.                                                                                         |
| `interpretation`        | How to read the result.                                                                                                                                               |
| `caveats`               | Small-sample, capture-gating and sampling-rate warnings.                                                                                                              |
| `sourceChannels`        | The `EventType` capture channels that feed it (ADR 0012).                                                                                                             |
| `related`, `comparable` | Metrics worth reading alongside; comparison semantics for deltas.                                                                                                     |
| `category`              | Grouping used by the docs, the capabilities resource and the health score.                                                                                            |

## Exports

**Data**

- `METRIC_REGISTRY` — the registry object, each entry's literal `builder` preserved.
- `METRIC_IDS` — every id, in declaration order.
- `FILTER_TARGETS` — every request parameter and the option field it drives.
- `DIMENSION_COLUMNS` — where each group-by dimension reads from in the event model.
- `AGGREGATION_BUILDER_NAMES` — every `build*` aggregation name `@uptimizr/db` exports.

**Helpers**

- `allMetrics()`, `getMetric(id)`, `isMetricId(value)`
- `metricForBuilder(builder)`, `isResourceMetric(metric)`

**Types**

`MetricDefinition`, `MetricId`, `MetricRegistry`, `MetricEndpoint`, `MetricGrain`,
`MetricCategory`, `MetricComparison`, `ColumnSemantics`, `ColumnUnit`, `DimensionId`, `FilterId`,
`FilterTarget`, `FilterOptionInterface`, `AggregationBuilderName`, `UnregisteredAggregation`,
`NoUnregisteredAggregations`.

## Adding a metric

A new aggregation is **not done until it has a registry entry**. The loop:

1. Add the `build*` aggregation in `@uptimizr/db`'s `src/query/aggregations.ts`.
2. Add its name to `AGGREGATION_BUILDER_NAMES` here, and a `MetricDefinition` to
   `METRIC_REGISTRY` keyed by the new `MetricId`.
3. Serve it from the collector and run `pnpm gen:docs` — the docs, MCP and agent tables regenerate
   themselves.

Four gates keep that honest:

- `NoUnregisteredAggregations` **fails to compile** when a declared builder has no entry.
- This package's `src/__tests__/registry.test.ts` checks coverage and internal consistency.
- `@uptimizr/db`'s `src/__tests__/registry.test.ts` asserts at runtime that
  `AGGREGATION_BUILDER_NAMES` is exactly the set of `build*` exports, and that every `row` schema
  parses the rows the aggregation really produces (run against DuckDB over the parity fixtures,
  and again with every number string-encoded — the shape ClickHouse returns over HTTP).
- The collector's `registryRoutes.test.ts` asserts each entry's endpoint and filters match the Zod
  querystring that actually serves it.

## Why this is its own package

`@uptimizr/db` owns the SQL builders, the dialects and the DuckDB store, so it depends on
`@duckdb/node-api` — a ~37 MB native binding. The registry is pure data, and its consumers
(`@uptimizr/agent-core`, `@uptimizr/mcp`, `@uptimizr/react`) run in a browser or over `npx`, where
a database driver is dead weight they can never use. Splitting the registry out means
`npm i @uptimizr/react` and `npx @uptimizr/mcp` never download one. See ADR 0051 §1 and ADR 0050.

## Links

- [Agent guide](./AGENTS.md)
- [Query API reference](https://uptimizr.com/docs/api/query/)
- [ADR 0051 — AI-first analytics layer](https://github.com/RaananW/Uptimizr/blob/main/docs/adr/0051-ai-first-analytics-layer.md)

## License

Apache-2.0

# AGENTS.md — @uptimizr/metrics

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

The **semantic metric registry**: one machine-readable `MetricDefinition` per Uptimizr analytics
metric. It is the single source of truth for _what can be asked_ of a collector — the endpoint, the
filters, the shape and units of a row, the row caps, how to read the answer and what not to trust.

It is **pure data**: `zod` and a type-only `@uptimizr/schema` import, nothing else. No `node:`
built-in, no DOM, no database driver. Import it from a browser bundle, a worker or an `npx` CLI.

## Install

```bash
pnpm add @uptimizr/metrics
```

## Canonical usage

```ts
import { allMetrics, getMetric, METRIC_IDS, type MetricDefinition } from "@uptimizr/metrics";

// Everything callable, as data.
for (const metric of allMetrics()) {
  metric.id; // the tool name / DSL metric name
  metric.endpoint?.path; // the collector route, when one exists
  metric.filters; // exactly the endpoint's querystring keys
  metric.row; // z.ZodObject — one row
  metric.limits.maxRows; // the hard cap; never ask for more
}

const metric: MetricDefinition | undefined = getMetric("perf_summary");
```

## Rules for agents

- **Derive, never restate.** Tool catalogs, OpenAPI paths, capability lists and docs tables are
  generated from this registry. If you find a hand-written table of endpoints or tools, it is a bug
  — regenerate it with `pnpm gen:docs` instead of editing it.
- **A new aggregation is not done until it has a registry entry.** Add the `build*` name to
  `AGGREGATION_BUILDER_NAMES` and a `MetricDefinition` to `METRIC_REGISTRY`; the
  `NoUnregisteredAggregations` type fails the build otherwise.
- **Keep this package dependency-free.** It exists so that `@uptimizr/agent-core`,
  `@uptimizr/mcp` and `@uptimizr/react` never pull in `@uptimizr/db`'s ~37 MB native DuckDB
  binding. Do not import `@uptimizr/db`, a `node:` built-in, or anything with a native/optional
  binary dependency. A test in this package enforces that.
- **Ids are a public contract.** A `MetricId` is the MCP tool name an existing client already
  calls. Rename nothing; add instead.
- **Respect `limits`.** `maxRows` is the registry's promise that no answer is unbounded;
  `maxSummaryRows` is what a model should be shown.
- **Read `caveats` before you conclude anything.** They record small-sample, sampling-rate and
  capture-gating conditions — a metric with no enabled source channel returns an honest empty
  result, not a zero.
- **`null` is not `0`.** An aggregate over no samples is SQL `NULL` and means "no data".

## Where the SQL lives

The `build*` aggregation each entry names is in [`@uptimizr/db`](../db)'s
`src/query/aggregations.ts`. This package deliberately does **not** import it — the link between
the two is asserted at runtime by `@uptimizr/db`'s `src/__tests__/registry.test.ts`.

## More

- Package reference: [README.md](./README.md)
- Query API: https://uptimizr.com/docs/api/query/
- ADR 0051 (AI-first analytics layer), ADR 0050 (browser-safe agent core), ADR 0020 (storage boundary)

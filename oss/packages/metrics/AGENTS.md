# AGENTS.md — @uptimizr/metrics

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

The **semantic metric registry**: one machine-readable `MetricDefinition` per Uptimizr analytics
metric. It is the single source of truth for _what can be asked_ of a collector — the endpoint, the
filters, the shape and units of a row, the row caps, how to read the answer and what not to trust.
It also owns the Zod mirrors of the three **result envelopes** (`format=full | table | summary`,
ADR 0051 §2), so the collector, the tool catalog and the MCP server describe one set of shapes.

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

```ts
import { resultEnvelopeSchema, structuredEnvelopeSchema, getMetric } from "@uptimizr/metrics";

const row = getMetric("top_meshes")!.row;
// Union of the three envelopes, for a caller that can express one (a route's
// 200 schema, a parser): rows[] | { meta, rows } | a summary digest.
resultEnvelopeSchema(row).parse(await response.json());
// The merged OBJECT form of the same union, for an MCP `outputSchema` — the
// SDK drops an output schema that is not an object, unions included.
structuredEnvelopeSchema(row);
```

This package also owns the **vocabulary half** of validating a query-DSL document
(ADR 0051 §3). `@uptimizr/schema`'s `queryV1Schema` checks the shape; `validateQuery` answers
the registry's questions and returns them as data:

```ts
import { validateQuery, nativeDimensions } from "@uptimizr/metrics";

const { issues, metric } = validateQuery(query); // [] means it can be run
issues[0]?.code; // "unsupported_filter" | "dimension_not_native" | "limit_too_large" | …
issues[0]?.accepted; // what *would* have worked, when that is a closed list

nativeDimensions(metric!); // the grain its rows actually carry, not everything it filters by
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
- **Describe a result with the envelope schemas, never a hand-written copy.** `tableEnvelopeSchema`,
  `summaryEnvelopeSchema`, `resultEnvelopeSchema` and `structuredEnvelopeSchema` are the one
  definition; `@uptimizr/db/summary` re-exports them under its established names, and the summariser
  that _builds_ an envelope still lives there.
- **Read `caveats` before you conclude anything.** They record small-sample, sampling-rate and
  capture-gating conditions — a metric with no enabled source channel returns an honest empty
  result, not a zero.
- **`null` is not `0`.** An aggregate over no samples is SQL `NULL` and means "no data".
- **`dimensions` is not the grain.** `MetricDefinition.dimensions` lists what a metric can be
  _filtered or keyed_ by; `nativeDimensions(metric)` is what its rows are actually keyed by.
  `top_meshes` declares `session` and returns one row per mesh — it can be scoped to a session,
  never broken down by one.

## Where the SQL lives

The `build*` aggregation each entry names is in [`@uptimizr/db`](../db)'s
`src/query/aggregations.ts`. This package deliberately does **not** import it — the link between
the two is asserted at runtime by `@uptimizr/db`'s `src/__tests__/registry.test.ts`.

## More

- Package reference: [README.md](./README.md)
- Query API: https://uptimizr.com/docs/api/query/
- ADR 0051 (AI-first analytics layer), ADR 0050 (browser-safe agent core), ADR 0020 (storage boundary)

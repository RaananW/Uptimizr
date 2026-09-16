# @uptimizr/db

The OSS storage contracts plus the single-file **DuckDB** store:

- **DuckDB (OSS default)** — one persisted `.duckdb` file holds **both events and metadata**, so
  the collector self-hosts in a single process with no external database service. A wide `events`
  table (hot fields like camera `position`/`direction`, pointer `screen`, `mesh`, `fps` promoted to
  columns; the full event preserved as JSON in `payload` so reads stay replay-complete) plus a
  dedicated `node_samples` table for high-cardinality `node_transform` rows, and `projects` /
  `api_keys` (stored only as SHA-256 hashes, with `query` / `ingest` capability).
- **Engine-neutral contracts** — the dialect-agnostic query layer (`buildX` + `Dialect`), the
  neutral event-row mappers (`toEventRow`, `toNodeSampleRow`, `formatUtcTimestamp`), and the
  metadata types (`Project`, `ApiKeyRecord`, `ResolvedApiKey`, `SceneRepresentation*`).

This package carries **no ClickHouse/Postgres dependency**. Optional scale adapters such as
`@uptimizr/db-clickhouse` compose these contracts behind the same interface. Server/Node only — no
DOM imports. Aggregations are **query-time** in v1; no materialized views.

> **Single-writer constraint.** DuckDB is an embedded, single-writer store: only one process may
> open the file read-write at a time. Run a single collector per file; for multi-writer /
> horizontal scale use the ClickHouse scale path. **Back up = copy the file.**

## Usage

```ts
import {
  createDuckdbClient,
  migrateDuckdb,
  duckdbInsertEvents,
  duckdbGetSessionEvents,
  duckdbResolveApiKey,
  buildPointerHeatmap,
  duckdbDialect,
  runDuckdbQuery,
  type HeatmapBinRow,
} from "@uptimizr/db";

const db = await createDuckdbClient("./data/uptimizr.duckdb");
await migrateDuckdb(db);

// ingest (events are validated upstream at the collector boundary)
await duckdbInsertEvents(db, events);

// query-time aggregation: one spec, rendered for the DuckDB dialect
const heat = await runDuckdbQuery<HeatmapBinRow>(
  db,
  buildPointerHeatmap("project-id", { bins: 50 }, duckdbDialect),
);

// ordered replay/timeline read
const timeline = await duckdbGetSessionEvents(db, "project-id", "session-id");

// authenticate ingestion
const projectId = await duckdbResolveApiKey(db, "utk_…");
```

Connection settings come from the environment (see [`.env.example`](../../../.env.example));
`readDbSettings()` exposes `DUCKDB_PATH`, the `CLICKHOUSE_*` settings used by adapters, and raw
session retention. When `DUCKDB_PATH` is unset the store defaults to
`<repo-root>/data/uptimizr.duckdb` — resolved against the monorepo root (the directory with
`pnpm-workspace.yaml`), not the process cwd, so the collector and the migrate/seed/new-project
CLIs all share one canonical file regardless of which package they run from. The collector selects
its backend with `COLLECTOR_STORE` (`duckdb` by default; `clickhouse` and `memory` are also wired in
`@uptimizr/collector-server`).

## Metric registry (`@uptimizr/metrics`)

The semantic layer over these aggregations — **what every aggregation means** — lives in its own
package, [`@uptimizr/metrics`](../metrics). It is a `Readonly<Record<MetricId, MetricDefinition>>`
with one entry per exported `build*` aggregation (plus two builder-less "resource" entries for the
session descriptor and the scene representation), declaring the metric's id, title, agent-facing
description, the builder behind it, its collector endpoint, result `grain`, group-by `dimensions`,
accepted `filters`, the output `row` schema (Zod), per-column semantics (unit, measure, label,
`rateOf`), row `limits`, how to read the result (`interpretation`), the `caveats` that make it
untrustworthy, the capture channels that feed it (`sourceChannels`, ADR 0012), `related` metrics
and comparison semantics. `DimensionId` and `FilterId` are closed unions declared once, and
`FILTER_TARGETS` maps each filter to the option field in `query/types.ts` it drives. (ADR 0051 §1.)

```ts
import { METRIC_REGISTRY, getMetric, allMetrics } from "@uptimizr/metrics";

const metric = getMetric("top_meshes");
metric?.endpoint; // { method: "GET", path: "/api/v1/meshes/top" }
metric?.row.parse(row); // validates one result row
```

It is a **separate package**, not a subpath of this one, because this package depends on
`@duckdb/node-api` — a ~37 MB native binding — while the registry's consumers
(`@uptimizr/agent-core`, `@uptimizr/mcp`, `@uptimizr/react`) run in a browser or over `npx` and
can never use a database driver. `@uptimizr/metrics` imports nothing but `zod` and a _type-only_
declaration from `@uptimizr/schema`, so it is pure data with no I/O.

### Numbers are numbers (ADR 0051 §2)

Every numeric column in a `row` schema is a strict `z.number()`, because that is what the collector
actually emits. Engines disagree about the wire — ClickHouse renders 64-bit integers and decimals
as JSON **strings** over HTTP, `pg` returns `int8`/`numeric` as strings without a type parser — so
each store's query runner normalises them at the single point rows leave its driver:

```ts
import { coerceRows, numericColumns } from "@uptimizr/db";

coerceRows("top_meshes", [{ mesh: "box", count: "42" }]); // [{ mesh: "box", count: 42 }]
numericColumns(getMetric("top_meshes")!.row); // ["count"]
```

`build*` aggregations tag their `QuerySpec` with the metric id, so `runDuckdbQuery`,
`runClickhouseQuery`, `runPostgresQuery` and `runMssqlQuery` each apply `coerceRows` with no work
at the call site. `null` stays `null` — an aggregate over an empty set is "no samples", never `0`.
A value that is neither a number, `null`, nor a finite numeric string **throws** under a test runner
and is left untouched with a one-per-column warning in production; pass `{ strict }` to pin either.
The parity suites assert `typeof === "number"` for every registry-numeric column on every engine.

> **A new aggregation is not done until it has a registry entry.** Add the `build*` name to
> `AGGREGATION_BUILDER_NAMES` and a `MetricDefinition` to `METRIC_REGISTRY` in
> `@uptimizr/metrics`; its `NoUnregisteredAggregations` guard fails to typecheck and names the
> missing builder. This package's `src/__tests__/registry.test.ts` then asserts at runtime that
> `AGGREGATION_BUILDER_NAMES` is exactly the set of `build*` exports, and parses every `row`
> schema against real DuckDB output over the parity fixtures; the collector's
> `registryRoutes.test.ts` asserts that every `endpoint.path` is served and that its Zod
> querystring keys equal the registry `filters`.

### Result envelopes (`@uptimizr/db/summary`, ADR 0051 §2)

The registry knows enough about a metric to **summarise** it, so the collector's
`format=table | summary` envelopes are built here rather than in a route handler. Pure, browser-safe
functions with no store and no I/O — published on their own subpath for the same reason the registry
is, and re-exported from the package root for Node consumers:

```ts
import { summarizeRows, tableResult, clusterCells } from "@uptimizr/db/summary";

tableResult("top_meshes", rows, { range, filters, limit });
// { meta: { metric, range, filters, sampleSize, rows, truncated, limits }, rows }

summarizeRows("top_meshes", rows, { range, filters });
// { kind: "ranked", total, measure, top: [{ label, value, share, … }], rest, reading, caveats, … }
```

The metric's `grain` picks the shape: `ranked` top rows for a leaderboard, a `series`
(first/last/min/max/trend/slope over the column flagged `axis`) for a time bucket, merged `clusters`
for a `bin`/`voxel` grid (`clusterCells` — a deterministic greedy merge of adjacent occupied cells
above a density threshold, 8-neighbourhood in 2D and 26 in 3D), and the `record` itself plus its
`rateOf` rates for a single-row metric. Everything is capped at `limits.maxSummaryRows`.

Two invariants worth knowing before extending it:

- **`reading` is templated, not generated.** It is assembled from `ColumnSemantics` alone, so the
  same rows always produce the same sentence. Every number goes through total formatters — a
  `reading` containing `undefined` or `NaN` is a test failure.
- **Shares are only claimed where they are true.** `total`, `share` and the Wilson `confidence` note
  appear only when the measure's unit is additive; an FPS or ratio measure reports `null` and says
  so in the `reading` rather than summing values that cannot be summed.

## Extending

- **New columns / tables:** append a migration to `DUCKDB_MIGRATIONS`. Forward-only and additive —
  never edit a shipped migration. The ClickHouse/Postgres scale migrations live alongside the
  scale store.
- **New aggregation — define once, emit per dialect:** add a pure
  `buildX(projectId, opts, dialect)` builder in `src/query/aggregations.ts` that renders a
  `QuerySpec` (`{ query, query_params }`) using the `Dialect` fragments (never hard-code
  engine-specific SQL). Run it with `runDuckdbQuery(db, buildX(..., duckdbDialect))`; the scale
  path runs the _same_ builder with `clickhouseDialect`. Add a `PARITY_CASES` entry so both engines
  stay provably equal, **and a `METRIC_REGISTRY` entry so consumers know what it means**. Builders
  are pure and unit-tested without a live database.

## Develop

```bash
pnpm --filter @uptimizr/db build
pnpm --filter @uptimizr/db typecheck
pnpm --filter @uptimizr/db test
```

Integration against real ClickHouse/Postgres lives with the scale store; the unit
tests here cover the pure mapping, the dialect-agnostic SQL builders, and the DuckDB store against
an in-memory (`:memory:`) database.

## License

[Apache-2.0](./LICENSE) © Uptimizr.

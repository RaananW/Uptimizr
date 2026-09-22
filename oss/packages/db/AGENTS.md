# AGENTS.md — @uptimizr/db

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

The OSS storage contracts plus the single-file **DuckDB** store (ADR 0020):

- **DuckDB** — one persisted `.duckdb` file holding both events and metadata. A wide `events`
  table (hot fields promoted to columns; the full event preserved as JSON in `payload` so reads
  stay replay-complete) plus `projects` / `api_keys` (stored only as SHA-256 hashes, each key
  carrying a capability set, an optional label and an optional per-key rate limit) and the
  `agent_audit` trail, the scene registry (`scene_representations`, `scene_regions`) and the
  project-metadata tables `annotations` / `glossary` / `saved_analyses` (ADR 0051 §5) and
  `panel_specs` (ADR 0051 §7).
- **Engine-neutral contracts** — the dialect-agnostic query layer (`buildX` + `Dialect`), the
  neutral event-row mapper (`toEventRow`, `formatUtcTimestamp`), and the metadata types
  (`Project`, `ApiKeyRecord`, `SceneRepresentation*`). An optional, separately-licensed
  scale store composes these to drive its single-tenant ClickHouse + Postgres engines.

This package carries **no ClickHouse/Postgres dependency**. The optional scale engines live in a
separately-licensed scale store. Server/Node only — no DOM imports. Aggregations are
**query-time** in v1 (no materialized views).

## Install

```bash
pnpm add @uptimizr/db
```

## Canonical usage

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

await duckdbInsertEvents(db, events); // events validated upstream at the collector boundary
const heat = await runDuckdbQuery<HeatmapBinRow>(
  db,
  buildPointerHeatmap("project-id", { bins: 50 }, duckdbDialect),
);
const timeline = await duckdbGetSessionEvents(db, "project-id", "session-id");
const projectId = await duckdbResolveApiKey(db, "utk_…");
```

Connection settings come from the environment (`readDbSettings()`); when `DUCKDB_PATH` is unset
the store defaults to `<repo-root>/data/uptimizr.duckdb`, resolved against the monorepo root so
every tool (collector + CLIs) shares one canonical file regardless of cwd.

## Rules for agents

- **Migrations are forward-only and additive.** Append to `DUCKDB_MIGRATIONS`; never edit a
  shipped migration (ADR 0007). The ClickHouse/Postgres scale migrations live alongside the
  scale store.
- A new aggregation = a pure `buildX(projectId, opts, dialect)` builder returning a `QuerySpec`
  (`{ query, query_params }`), run with `runDuckdbQuery`. Keep builders pure, dialect-agnostic,
  and unit-tested without a live database; add a `PARITY_CASES` entry so both engines stay equal.
- **A new aggregation is not done until it has a metric-registry entry** (see below). The build
  fails without one.
- Validate events upstream at the collector boundary; this layer assumes valid input.
- API keys are only ever stored as SHA-256 hashes — never persist raw keys.
- **Key capabilities are a set, not a role** (ADR 0051 §7): `ingest`, `query`, `annotate`,
  `query:raw`, persisted as a canonical comma-separated token list in `api_keys.capabilities`.
  Always read it with `parseApiKeyCapabilities(capabilities, capability)` so a key issued before
  the set existed still resolves via the legacy singular column; always write it with
  `toApiKeyColumns()` so ordering, validation and the per-key rate-limit columns stay consistent
  across all four engines. `query:raw` is only ever honoured by a collector running with
  `ENABLE_RAW_SESSION_RETENTION` (ADR 0003).
- **Metadata tables are writable; the events table is not.** `annotations`, `glossary`,
  `saved_analyses` and `panel_specs` are the only rows a request can write besides events
  (ADR 0051 §5/§7/§9). Their accessors enforce the per-project caps in `METADATA_LIMITS` at write
  time and throw `MetadataLimitError` when a project is full — the collector turns that into a
  `409`. Never add a path that updates or deletes an event row.
- **`panel_specs` is the one metadata table with an in-place update** (ADR 0051 §7). A spec is one
  closed JSON document — a metric id, a chart name, some column names — that no read path queries
  into, stored beside only what the store must filter (`project_id`), order (`created_at`) and
  address (`id`). `duckdbCreatePanelSpec` / `duckdbListPanelSpecs` / `duckdbUpdatePanelSpec` /
  `duckdbDeletePanelSpec` are the accessors; `parsePanelSpec` maps the JSON column back and returns
  `null` for a row that is not an object, which the listing drops rather than failing the whole
  grid on. Two things differ from the other three tables and must stay that way: the listing is
  **oldest first**, because these are grid positions rather than a feed and a new pin must not
  reshuffle somebody's dashboard, and an update keeps the row's id **and its original
  `authorKind` / `authorKeyId`** — who pinned a panel is a fact about when it appeared, and an edit
  does not change it. Migrations: DuckDB `0048_panel_specs` + `0049_panel_specs_idx`, Postgres
  `0020_panel_specs`, SQL Server `0022_panel_specs` + `0023_panel_specs_idx`, ClickHouse
  `0017_panel_specs`.
- **The audit log records key ids, never keys.** `agent_audit` rows carry `key_id`; serialize
  parameters with `serializeAuditParams()` (drops credential-shaped keys, bounds the document)
  before they reach a store, and clamp the endpoint with `clampAuditTool()`.
- **Single-writer store.** DuckDB allows only one read-write process per file; assume a single
  collector per `.duckdb` file. Back up = copy the file. Multi-writer / horizontal scale is the
  optional ClickHouse scale tier, not this package.

## Metric registry (ADR 0051 §1)

[`@uptimizr/metrics`](../metrics) is the semantic layer over the aggregations: one
`MetricDefinition` per exported `build*` (plus two builder-less resource entries — `session_meta`,
`scene_representation`) declaring id, title, agent-facing description, builder, collector endpoint,
`grain`, `dimensions`, `filters`, the output `row` Zod schema, per-column semantics (unit /
measure / label / axis / `rateOf`), row `limits`, `interpretation`, `caveats`, `sourceChannels`
(the ADR 0012 capture dials that must be on for the metric to have data), `related` metrics,
`comparable` semantics and a `category`. `DimensionId` / `FilterId` are closed unions declared
once; `FILTER_TARGETS` maps each filter to the `query/types.ts` option field it drives.

```ts
import { getMetric, allMetrics, METRIC_IDS } from "@uptimizr/metrics";
```

Its own **package**, not a subpath here, because this one depends on the ~37 MB
`@duckdb/node-api` native binding and the registry's consumers (`@uptimizr/agent-core`,
`@uptimizr/mcp`, `@uptimizr/react`) can never use a database driver. `@uptimizr/metrics` imports
**only** `zod` plus a type-only `@uptimizr/schema` declaration, performs no I/O and holds no store
or dialect reference.

### Custom-event vocabulary (ADR 0051 §5)

`buildCustomEventVocabulary` is the one aggregation whose SQL output is **not** what the API serves.
Key _enumeration_ over an open JSON object is the single JSON operation the four supported engines
have no portable spelling for (`json_keys` / `JSONExtractKeys` / `jsonb_object_keys` / `OPENJSON`),
and `Dialect.jsonText` cannot express it — it reads a value at a _known_ path. So the query does what
SQL is good at (counts and distinct sessions per `custom` event name, plus that name's most recent
`payload` documents, bounded by `CUSTOM_EVENT_VOCABULARY_SAMPLE_ROWS` = 20 per name), and
`foldCustomEventVocabulary(rows)` — pure, unit-tested, no dialect — turns the sampled payloads into
one row per name with the union of prop keys and a coarse type each.

- Every store calls the fold in its `customEventVocabulary` method. The **raw payload never leaves
  the store layer**: the collector serves the folded rows, and only key names and value kinds, never
  a prop value (ADR 0003).
- The registry `row` for `custom_event_vocabulary` therefore describes the **folded** row; the parity
  case compares the counts and the sampling shape and excludes `sample_payload`, which is engine
  formatted (Postgres normalises it through `jsonb`).
- Do not add a `jsonKeys` member to `Dialect` to "fix" this without a good reason: four dialects would
  have to agree on key ordering, type coercion and NULL handling for a discovery read.

### Numeric coercion at the store edge (ADR 0051 §2)

Numeric columns are strict `z.number()` — the schema describes the API, not the wire. Every
`build*` tags its `QuerySpec` with the metric id, and each store's runner (`runDuckdbQuery`,
`runClickhouseQuery`, `runPostgresQuery`, `runMssqlQuery`) calls `coerceRows(spec.metric, rows)` at
the one point rows leave the driver, so a string-encoded 64-bit integer or decimal becomes a number
before any consumer sees it. `null` passes through — an aggregate over an empty set is "no
samples", not `0`, which is why nine perf/resource metrics declare nullable columns.

- **Do not** reintroduce `z.coerce.number()` in `registry.ts`: a registry test proves that
  string-encoded rows _fail_ the strict schema and _pass_ after `coerceRows`, which is what pins
  the work to the edge.
- A new store must call `coerceRows` in its runner; the parity suite asserts
  `typeof === "number"` for every registry-numeric column on every engine (`numericColumnsForSpec`).
- Junk in a numeric column throws under a test runner and is left untouched with a one-per-column
  warning in production (`coerceRows(..., { strict })` pins either).

**Rules for agents:**

- A `build*` aggregation added here must also be added to `AGGREGATION_BUILDER_NAMES` in
  `@uptimizr/metrics`, and given a registry entry. Missing the entry is a **compile error**
  (`NoUnregisteredAggregations` names the missing builder); missing the list entry fails this
  package's `registry.test.ts` at runtime and names it too.
- **Never import `@uptimizr/db` from `@uptimizr/metrics`.** The dependency runs one way only —
  that is the whole point of the split. The builder-name list is literal data for that reason.
- The 20 ids that are already `@uptimizr/agent-core` tool names (`top_meshes`, `perf_summary`,
  `list_sessions`, …) are frozen — renaming one breaks every MCP client.
- `row` must match what the SQL actually projects, not what `types.ts` declares. It is also the
  collector's **response schema**, so an undeclared column is stripped from the API and a `null` in
  a non-nullable one is a 500. Four suites enforce this: `@uptimizr/metrics`' `registry.test.ts`
  (coverage, internal consistency), this package's `registry.test.ts` (the builder link, plus `row`
  parsing against real DuckDB output over the parity fixtures and the string-encoded ClickHouse
  shape through `coerceRows`), the collector's `registryRoutes.test.ts` (endpoint exists;
  querystring keys === `filters`) and its `queryResponseSchemas.test.ts` (every endpoint, against a
  seeded store, an empty one, and the in-memory store).

### Result envelopes (ADR 0051 §2, `@uptimizr/db/summary`)

`summarizeRows(metric, rows, ctx)` and `tableResult(metric, rows, ctx)` build the collector's
`format=table | summary` envelopes. Pure, registry-driven, browser-safe; the collector calls them
from one `preSerialization` hook, so no route handler knows they exist.

```ts
import {
  summarizeRows,
  tableResult,
  clusterCells,
  labelClusters,
  labelPoint,
  isWorldSpatialMetric,
  wilsonInterval,
} from "@uptimizr/db/summary";
```

The **Zod mirrors** of the envelopes (`tableResultSchema`, `resultSummarySchema`,
`resultEnvelopeSchema`, `resultFormatSchema`) are still exported from the same subpath, but they
are now defined in [`@uptimizr/metrics`](../metrics) and re-exported here: `@uptimizr/agent-core`
and `@uptimizr/mcp` describe the same envelopes in their tool output schemas and may not depend on
this package. Change a shape **there**, never here.

The `grain` selects the shape — `ranked` (top rows + `rest`), `series` (first/last/min/max/trend/
slope over the `axis` column), `clusters` (`clusterCells`: deterministic greedy merge of adjacent
occupied cells above a density threshold, 8-neighbourhood in 2D / 26 in 3D), or `record` (the single
row plus its `rateOf` rates). Everything is bounded by `limits.maxSummaryRows`.

### Spatial labelling (`labels.ts`, ADR 0051 §2 / sketch §B.2)

Pass a `SummaryContext.scene` — `{ id, regions: [{ id, bounds }], meshes: [{ name, aabb }] }`, which
the collector loads from the scene registry once per request — and every cluster of a **world-space**
grid is labelled: `region` (smallest containing region by volume), `regions[]` (every containing id,
ascending), `nearestMesh` (a proxy box containing the centroid, else the nearest box centre within
`cellSize × 2`) and `distance` (world units; `0` when contained). A containing region also upgrades
`drill.region` from an ad-hoc world box to the region **id**, which `?region=` resolves server-side.

`isWorldSpatialMetric(metric)` says whether a metric is worth loading a scene for: only the voxel
(`vx/vy/vz`) and ground-bin (`gx/gz`) grids are world-space — the viewport pointer/UV bins and the
angular view-direction grid are not, and are left untouched. Cost is `O(clusters × boxes)` with a
per-axis early exit; `spatialLabels.test.ts` holds the largest shape under 50 ms.

**Rules for agents:**

- A metric's summary comes from its **column semantics**, never from a per-metric special case. If a
  metric summarises badly, fix its `unit` / `measure` / `label` / `axis` / `rateOf` declarations.
- A `bucket`-grain metric must declare exactly one `axis: true` column, and no other grain may
  declare one (`@uptimizr/metrics`' `registry.test.ts`). `label` cannot stand in — `mesh_trend`
  labels rows by mesh.
- **`reading` is templated, never model-written**, and must never contain `undefined` or `NaN`; run
  every value through `format.ts`'s total formatters.
- Report `total`/`share` only for an **additive** unit. Summing FPS, a ratio or a percentile across
  rows is meaningless, and a share derived from it is worse than none.
- Clustering must stay a pure function of the cell _set_: accumulate in sorted coordinate order so a
  reordered input is bit-identical (`summary.test.ts` rotates every fixture).
- Labelling must stay a pure function of the region/mesh _sets_ too: break every tie by id or name
  ascending, never by array order, and report `null` rather than a far-away guess.
- Adding `format` to a metric's `filters` and to the collector's querystring is one change — the
  collector's `registryRoutes.test.ts` fails if they drift.
- The collector's `format` default is **`full`** and must stay that way — it is what keeps the
  feature invisible to the dashboard. The generated agent tools apply their own `table` default
  and send it explicitly (`DEFAULT_TOOL_FORMAT` in `@uptimizr/agent-core`).

## Query DSL (ADR 0051 §3)

`compileQuery(projectId, query, dialect)` turns a validated `queryV1` document (the Zod grammar in
`@uptimizr/schema`, the registry validation in `@uptimizr/metrics`) into an ordinary `QuerySpec`, by
way of the metric's **existing** builder: the registry names the `build*`, `FILTER_TARGETS` names the
option field each filter drives, and the builder renders what it has always rendered.

```ts
import { compileMetric, compileQuery, toBuilderOptions } from "@uptimizr/db";

// A store's whole DSL implementation:
runMetric: (projectId, metric, options) =>
  runDuckdbQuery(db, compileMetric(metric, projectId, options, duckdbDialect));
```

- **No second SQL path.** The spec a DSL query compiles to is byte-identical to the one the canned
  endpoint runs — `src/__tests__/queryDsl.test.ts` asserts that for every aggregation on all four
  dialects, and `PARITY_CASES` carries `dsl:*` cases that execute compiled specs against the same
  golden. Everything parity already proves about a builder holds for the DSL.
- **It does not validate.** By the time a query reaches `compileQuery` it has passed
  `queryV1Schema` and `validateQuery`. The two `throw`s are guards against a caller skipping that.
- **Two values must be resolved first**, by whoever has a store: a `filters.region` given as a
  registered region id (→ its bounds) and a spatial `cellSize` derived from the scene's extent. Pass
  them as the `QueryResolution` argument.
- **The generic tier is the second compiler**, not a second _path_: `compileGenericGroupBy`
  (`query/dsl/generic.ts`) renders `SELECT <dims>, <measures> … GROUP BY <dims>` for a metric that
  declares `genericGroupBy`, at any grain it declares. Everything variable in that SQL comes from
  registry data — the event types, the scope predicate, the measures, each dimension's expression —
  and every caller-supplied value is a bound parameter. `compileMetric` dispatches on
  `options.tier`, which only `toBuilderOptions` sets, so a store calling `runMetric` with a plain
  option bag keeps the delegated behaviour it has always had.
- **Four pure layers sit on top**, none of which runs a query: `compareRows` /
  `summarizeComparison` (join two runs of the same spec on the dimension key),
  `twoProportionZ` / `welchT` (is the difference real — pinned to published table values in
  `querySignificance.test.ts`), `explainQuery` (the plan and its warnings), and `applyOrder`
  (an honest re-sort of a delegated result, with `ORDER_AFTER_CAP_CAVEAT` when the builder's own
  cap had already chosen the rows).
- **`explain` shows the SQL because there is nothing in it to redact.** `explainSpec` lists
  parameters by name and logical type and never by value; the SQL text carries placeholders only,
  which is exactly the property a reader uses `explain` to check.

## Session narrative (ADR 0051 §7)

`buildSessionNarrative(events, opts)` compacts one session's `AnyEvent[]` into an ordered,
bounded account of what it did; `renderSessionNarrativeText(narrative)` renders it as one line per
entry. Both are **pure** — no store, no request, no I/O — and live in `src/narrative/`.

```ts
import { buildSessionNarrative, renderSessionNarrativeText } from "@uptimizr/db";

const narrative = buildSessionNarrative(events, { minDwellMs: 2000, maxEntries: 200 });
narrative.entries; // ordered { tMs, kind, summary, refs }, ending with the `summary` entry
narrative.totals; // { events, durationMs, scenes, meshes, interactions, dips, errors }
console.log(renderSessionNarrativeText(narrative));
```

Shapes, defaults and hard caps live in `@uptimizr/metrics` (`NARRATIVE_LIMITS`,
`sessionNarrativeEntrySchema`) so the collector route, the generated `session_narrative` tool and
this implementation cannot drift.

**It is an allow-list, not a redactor** (ADR 0003). It reads only: relative timestamps, scene ids,
mesh names, interaction kinds and input sources, custom-event/input-action names, FPS, truncated
runtime-error messages, diagnostic category/severity, capability transitions, and the rendering
engine. It never reads `visitorId`, `url`, `pageMeta`, `user`, any position/ray/UV, any other
`device` field, or custom-event property values (keys only, unless `includeCustomProps`). Keep it
that way when adding an event type — adding a field to the switch is a privacy decision.

### Insight primitives (ADR 0051 §4, `src/insights/`)

`baseline`, `movers`, `anomalies`, `significance` and `scene_health` — "what is normal here",
"what changed", "_when_ did it go wrong", "is that change real" and "which scene should I look at
first" — as five derived registry metrics. The shape of the directory is the design:

```ts
import {
  buildMetricBuckets, // the ONE dialect-authored query both primitives consume
  computeBaseline,
  rankMovers,
  resolveBaselineWindow,
  resolveMoversWindows,
  BUCKET_MEASURES, // metric id -> how its primary column buckets
  BUCKETABLE_METRIC_IDS,
  MOVERS_DEFAULT_METRICS,
  MOVERS_MAX_METRICS,
  detectAnomalies, // #306: robust z per bucket + CUSUM change-points
  contributorDimensionFor, // the ONE dimension a metric's excess may be split by
  contributorWindows, // the windows attribution is allowed to re-scan
  attributeContributor,
  ANOMALY_MAX_CONTRIBUTOR_SCANS,
  // --- significance / scene health (#307) ---
  computeSignificance, // picks the test from the measure: proportions / Poisson / Welch
  computeSceneHealth, // six weighted factors, each traceable to its metric
  rankSceneHealth,
  resolveHealthWindows,
  HEALTH_FACTORS, // the fixed factor catalog, with default weights
  BUCKET_MEASURE_VARIANTS, // named auxiliary series: a rate denominator, an FPS tail
} from "@uptimizr/db";
```

**Rules for agents:**

- **No statistic may be computed in SQL.** Five dialects disagree about `quantile`, `median` and
  `stddev`; an insight that changes with the storage engine is not an insight. The query returns raw
  per-bucket values and `stats.ts` does the rest in TypeScript.
- `buildMetricBuckets` lives in `src/insights/`, **not** in `query/aggregations.ts`. The `build*`
  exports of that module are the registry's closed list of _metrics_, each of which must have its own
  entry and endpoint; this is the shared _input_ of two metrics and has neither.
- A metric is bucketable only if it has an entry in `measures.ts`, and that entry's `column` must be
  the metric's `comparable.primary` (asserted in `src/__tests__/insights.test.ts`). Widening the
  catalog is additive: add the measure, add a parity case, done.
- A metric may also declare **named auxiliary series** (`BUCKET_MEASURE_VARIANTS`): a rate
  denominator, an FPS tail, the numerator of a ratio whose metric has no headline series at all.
  A variant is **never** caller input — `significance` picks `denominator` from the registry and
  `scene_health` reads a fixed factor catalog — and declaring one does **not** make the metric
  bucketable: `isBucketableMetric` still answers about the metric's own headline column, so
  `baseline` and `movers` keep rejecting `jank_rate` and `xr_abandonment` as before.
- **Which test `significance` runs is derived, not configured**: a declared rate (a `rateOf`
  headline column plus a `denominator` variant) gets a two-proportion z with Wilson/Newcombe
  intervals, a `count`/`sessions` aggregate gets an exact Poisson rate test, and everything else
  gets Welch's t over the per-bucket values. Welch's `n` is the **bucket count**, never the event
  count: samples inside one day are not independent.
- **Every `scene_health` factor must stay traceable.** A factor row carries the metric id, the raw
  value, the project baseline it was compared with and the weight it took. A factor that could not
  be measured reports `score: null` with a reason and is excluded from the mean — never defaulted
  to 50, and never dropped from the row.
- **Never approximate a series to widen the catalog.** Funnels, cohort metrics and anything defined
  by the relationship between consecutive events have no faithful per-bucket form; a `400` naming the
  ids that do is a better answer than a plausible wrong number.
- Predicates come from a **closed vocabulary** over promoted columns, with constant values bound as
  parameters. Do not add a free-SQL escape hatch.
- Window bounds snap **down** to whole buckets, so the day or hour in progress is excluded and a
  default reference really is an equal window. `resolveHealthWindows` is the deliberate exception
  (it rounds `until` **up**): every health factor is a rate or a percentile, which a partial bucket
  does not distort, and flooring would make the score answer about yesterday.
- `movers` reports a sub-`minSample` delta with `aboveMinSample: false` and ranks it below every
  gated mover. It must never be dropped — "we cannot tell" and "nothing changed" are different
  answers — and never reported as a finding.
- Cost is bounded by `MOVERS_MAX_METRICS` (one grouped scan per scanned metric). Raising it is a
  deliberate change, not a default.
- `anomalies` (#306) adds **one** piece of per-dialect SQL and no more: an optional `groupBy` on
  `buildMetricBuckets` that adds one promoted column to the `SELECT`/`GROUP BY`. The column comes
  from the measure's own `splitBy`, a compile-time union — never from request input — and the shape
  has its own `metricBuckets:split*` parity cases on all four engines.
- `anomalies`' `z` divides by the MAD **rescaled to a standard deviation** (`MAD_TO_SIGMA`), because
  `sensitivity` is a threshold and an uncalibrated one reports ordinary days. `movers` divides by the
  raw MAD because it ranks. Do not "unify" them without moving the default with it.
- Attribution is capped at `ANOMALY_MAX_CONTRIBUTOR_SCANS` extra grouped scans per request, whatever
  the data looks like. The cap, not the data, is what bounds the endpoint.
- `significance` and `scene_health` (ADR 0051 §4) slot in here the same way: a new pure module over
  the same bucket series.

## Cross-engine parity (ADR 0020)

The dialect-agnostic aggregations (`buildX(projectId, opts, dialect)`) are rendered per engine
(`duckdbDialect` for OSS, `clickhouseDialect` for the scale tier). A shared parity harness
proves the engines produce equal analytics:

- `PARITY_EVENTS` — one deterministic fixture event set exercising every aggregation (2D/3D
  heatmaps, the camera-direction gaze heatmap, the ASOF click↔gaze ray and flow joins, quantile
  perf, the daily rollups, and the scene/session dimensions).
- `PARITY_CASES` — each aggregation paired with its engine-independent **golden** output (authored
  as truth, hand-verified from the fixtures).
- `diffParity(actual, golden, { sortKeys, ignoreColumns })` — compares under the tolerance rules
  below and returns a list of differences (empty = parity).

OSS ships the **DuckDB-vs-golden** suite (`src/__tests__/duckdbParity.test.ts`, CI-runnable, no
service). The scale tier reuses the same exported `PARITY_CASES`/golden to run
**DuckDB-vs-ClickHouse**; two engines that both match the golden are in parity by transitivity.

**Tolerance rules** (see `src/parity/compare.ts`):

1. **Order-insensitive** — rows are compared as a multiset, sorted by each case's `sortKeys`
   (SQL guarantees no order beyond `ORDER BY`, and `ORDER BY count` ties are unstable).
2. **Float tolerance** — continuous numeric columns (averages, quantiles, ASOF ray origins/hits)
   match within `PARITY_ABS_TOLERANCE` (1e-6 absolute) or `PARITY_REL_TOLERANCE` (1e-9 relative).
3. **Bin indices are integer-exact** — `floor(...)` heatmap bins are integers; fixtures avoid
   exact bin boundaries where a sub-ulp difference could flip the floor across engines.
4. **Temporal projections excluded** — wall-clock `TIMESTAMP` columns (`started_at`, `ended_at`,
   `last_seen`) render differently per engine and are listed in `ignoreColumns`; date-granular
   `day` strings (`YYYY-MM-DD`) render identically and are compared.

When adding an aggregation or event type, extend `PARITY_EVENTS`/`PARITY_CASES` with golden so both
engines stay covered. The `metricBuckets:*` cases cover the insight bucket series — one per aggregate
shape its measure catalog can render, which is what makes `baseline`/`movers` portable.

## More

- Package reference: [README.md](./README.md)
- Integration guide: https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md

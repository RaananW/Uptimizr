# @uptimizr/metrics

## 0.2.0

### Minor Changes

- 395aa36: Insight primitives: `baseline` and `movers` (ADR 0051 §4)

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

- f5fc7b6: Declarative panel specs and "Pin as panel" (ADR 0051 §7)

  An agent's answer used to disappear when the chat closed. A **panel spec** keeps
  it: a title, the query that produced it, how to draw the result, and the one-line
  reading that made it worth keeping. The dashboard loads a project's specs on
  mount and renders them alongside its built-in panels.

  **A panel is data, never code.** ADR 0041 can load a remote panel _module_ at
  runtime, and is explicit about the cost: such a module runs with the dashboard's
  full privileges, which is why it is off by default and guarded by an origin
  allowlist. A panel written by a language model would be exactly that. So a spec
  is a closed document — a metric id, a chart name, some column names — and
  `specPanel()` draws it with the panel components `@uptimizr/react` already
  ships. There is nothing to import and nothing to evaluate; ADR 0041's trust
  decision is not widened.

  - **`@uptimizr/schema`** — `panelSpecV1Schema` and friends. The spec's `query`
    is a `queryV1` document whose `range` may additionally be the literal
    `"inherit"`, meaning "whatever the dashboard's filter bar currently says". It
    is built by overriding one key of `queryV1Schema` rather than restating the
    grammar, so a filter added to the DSL reaches panel specs in the same commit.
  - **`@uptimizr/metrics`** — `validatePanelSpec()` answers the question that
    decides whether a panel will draw anything: does this chart suit the metric's
    grain, and do these encoding columns exist in its result. A `line` over a
    ranking is not a crash — it renders _something_, which somebody reads as a
    trend a week later — so it is refused at pin time with the validator's issue
    codes, naming the charts that would have worked. The compatibility table is
    `PANEL_CHART_RULES`, published in the docs and pinned by a test. Plus a pure
    `suggestChart()`, which never proposes a spec the collector would refuse.
  - **`@uptimizr/db`** and the three optional engines — a `panel_specs` table on
    all four stores. Listed **oldest first**, because these are positions in a
    grid rather than a feed, and a spec can be updated in place, keeping its id
    and its original authorship. Bounded at 50 per project: every spec is a query
    the dashboard runs on every load.
  - **`@uptimizr/collector-server`** — `GET`/`POST /api/v1/panels` and
    `PUT`/`DELETE /api/v1/panels/:id`. Writes need `annotate`, reads need `query`,
    every write is audited, and a rejected spec answers `400 { error, issues }` —
    the same body a rejected query gets. OpenAPI under a new `panels` tag.
  - **`@uptimizr/react`** — `specPanel(spec)` returns an ordinary ADR 0036
    `PanelDefinition` (id `spec:<id>`, the note as its subtitle) whose `load`
    resolves `"inherit"` from the host's active window on every render.
    `loadSpecPanels(api)` mirrors ADR 0041's loader: a spec that cannot be drawn
    is reported and skipped, so one bad row never empties a dashboard. The
    `CollectorApi` gains `query()`, `panels()`, `pinPanel()`, `updatePanel()` and
    `unpinPanel()`.
  - **The dashboard** marks each spec panel "Pinned by agents" and offers an unpin
    control to a key that holds `annotate`. ADR 0039's per-panel hide and settings
    work on a spec panel by id, unchanged.
  - **The assistant and MCP** — a "Pin as panel" action on any answer that came
    from a `query` tool call, and the `pin_panel`, `list_panels` and `unpin_panel`
    tools, gated on `annotate` like the rest of the metadata catalog.

  Migrations are forward-only and idempotent: DuckDB `0048`–`0049`, Postgres
  `0020`, SQL Server `0022`–`0023`, ClickHouse `0017`.

- 395aa36: Insight primitive: `anomalies` (ADR 0051 §4)

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

- 0c7507d: Agent tools accept the `table` and `summary` result envelopes, and default to `table`.

  A generated tool's `outputSchema` was the registry row array, so a call with `format=summary` or
  `format=table` — the envelopes the guides tell agents to prefer — came back as a result the MCP SDK
  rejected with `-32602 Output validation error`, on stdio and over `/mcp` alike. The schema now
  describes all three envelopes, and `@uptimizr/mcp` returns the one that was asked for as
  `structuredContent` (`full` keeps its `{ rows }` wrapping) instead of stripping it to rows.

  **Behaviour change:** a tool called without `format` now asks the collector for `table` — the same
  rows plus the `meta` block (metric, range, applied filters, sample size, row count, truncation flag,
  limits) — where it used to ask for nothing and get bare rows. `full` is still available and
  unchanged, and the collector's own default is still `full`, so an HTTP client such as the dashboard
  is unaffected: the default lives in the tool and travels as an explicit `format=table`. A consumer
  that reads a tool's `structuredContent` as an array must either ask for `format: "full"` or read
  `.rows`. The argument stays optional, so no call becomes invalid.

  The Zod envelope schemas now live in `@uptimizr/metrics` (`resultEnvelopeSchema`,
  `tableEnvelopeSchema`, `summaryEnvelopeSchema`, `structuredEnvelopeSchema`, `resultFormatSchema`),
  which is what lets the browser-safe agent packages describe them without depending on
  `@uptimizr/db`. `@uptimizr/db/summary` re-exports them under its existing names, so that package's
  public API is unchanged; the summariser that builds an envelope has not moved.

  `@uptimizr/react`'s assistant inherits the new default: its tool calls now carry `format=table`, so
  the model sees the `meta` context with its rows.

- 395aa36: Insight primitives: `significance` and `scene_health` (ADR 0051 §4)

  Two more registry metrics under `/api/v1/insights/`, completing the Stage 2 set:

  - **`insight_significance`** (`GET /api/v1/insights/significance`) — is that
    difference real? Compares one comparable metric across two windows and reports
    `{ a, b, effect, ci95, p, test, effectUnit, significant, powerNote }`, with the
    test **chosen from what the measure is**: a two-proportion z with Wilson intervals
    and a Newcombe hybrid-score interval on the difference when the metric's headline
    column declares a `rateOf` denominator, an exact Poisson rate test (conditional
    binomial) for a bare count, and Welch's t over the per-bucket values for a level or
    a summed quantity. Welch counts **buckets**, not events, because samples inside one
    day are not independent. `powerNote` states the smallest difference these sample
    sizes could have detected at 80% power, so "no effect" stays distinguishable from
    "not enough data".
  - **`insight_scene_health`** (`GET /api/v1/insights/scene-health`) — which scene is in
    trouble, and why? One 0-100 score per scene over six weighted factors — perf
    stability (p05 FPS), jank rate, error rate, dead-click rate, exploration coverage
    and XR abandonment — each normalised against the **project's own baseline over the
    preceding equal window**, so 50 is the project norm rather than a pass mark. Every
    factor reports the metric id behind it, its raw value, the baseline it was compared
    with and the weight it carried, so the score can always be taken apart. Weights are
    declared in the registry entry (and so appear in `capabilities`) and are overridable
    per request with `weights`.

  Both are ordinary registry entries, so they arrive as agent and MCP tools, in the
  generated OpenAPI document and in the capabilities resource automatically, and they
  accept `format=table | summary`. Every statistic — p-values, confidence intervals and
  the health score alike — is computed in **pure TypeScript** over the same portable
  per-bucket query, so no two storage engines can disagree about one.

  `@uptimizr/db` additionally exports the statistics themselves (`twoProportionTest`,
  `welchTest`, `poissonRateTest`, `newcombeDifferenceInterval`, `wilsonBounds`,
  `studentTwoSidedP`, `binomialCdf`, `normalCdf`) so a caller that needs one of these
  tests outside the insight endpoints does not have to reimplement it.

  `@uptimizr/react` gains a **Scene health score** tile in the OSS panel catalog
  (`sceneHealthScorePanel` / `SceneHealthScoreView`) and `CollectorApi.sceneHealth()`.
  Each factor bar names the metric behind it, so the tile routes rather than dead-ends.
  The existing `scene-health` panel (raw event counts for the selected window) is
  unchanged.

  The `weekly_scene_health` MCP prompt now leads with `insight_scene_health`, then
  `insight_movers`, and tells the agent to confirm any single change with
  `insight_significance` before reporting it.

  `insight_significance` compares two **time windows** in v1. A segment-versus-segment
  contrast (variant A vs variant B) needs the bucket series split by a promoted
  dimension and returns `400` naming the window parameters rather than answering the
  wrong comparison.

- 395aa36: **Query DSL stage 2** (ADR 0051 §3, #304): `compare`, `explain`, runnable drill hints, `order`,
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

- 395aa36: **Query DSL v1** (ADR 0051 §3): every metric the collector can compute now answers to **one**
  endpoint, `POST /api/v1/query` — and `GET /api/v1/query?q=<url-encoded JSON>` for GET-only clients.
  Name the `metric`, bound it with a required `range`, narrow it with the filters that metric declares,
  cap it with `limit`, and pick the envelope with `format` (which defaults to `table` here). Both forms
  are reads: the same `query` capability, the same audit trail, the same aggregations.

  The grammar is **closed** — `queryV1Schema` in `@uptimizr/schema` — with no SQL, no expression
  language, typed filters, bounded output and unknown keys rejected. The metric, dimension and filter
  vocabularies are exactly the registry's: `validateQuery()` in `@uptimizr/metrics` checks a query
  against it and returns every objection as data, each with a stable `code`, the offending path and —
  where it is a closed list — the values that _would_ have been accepted, so a wrong guess comes back
  as a correction rather than an empty result an agent would report as a finding.

  v1 is the **delegated** tier: `compileQuery` in `@uptimizr/db` maps a query onto the metric's
  existing aggregation builder through the registry's `FILTER_TARGETS`, and every store runs it with
  the one new `runMetric` method. So a DSL query compiles to the _identical_ `QuerySpec` the canned
  endpoint runs — asserted per metric on all four dialects, with `dsl:*` parity cases executing
  compiled specs against the same goldens — and it inherits parameter binding, numeric coercion at the
  store edge and cross-engine parity without a second SQL path. `dimensions` must therefore be the
  metric's own grain, and `compare`, `segment`, `order`, `explain`, `filters.event` and
  `filters.device` are part of the published grammar but answer `400 … not supported yet`.

  `@uptimizr/agent-core` gains one generated `query` tool whose input _is_ the DSL (appended to
  `readTools`, so every existing tool name and schema is unchanged), reaching the collector over the
  GET form so the read-only `CollectorClient` stays `GET`-only. `@uptimizr/mcp` registers it with an
  output schema and lists it in `uptimizr://capabilities` alongside the per-metric tools.

- 395aa36: Session narrative: `GET /api/v1/sessions/:id/narrative` compacts one session's raw stream into an ordered, bounded account of what it did — scene changes, per-mesh dwell, interactions, perf dips, errors, capability changes, XR and the end reason, with timestamps relative to the session start and a closing totals entry. It is gated exactly like the raw event stream (`ENABLE_RAW_SESSION_RETENTION` **and** a `query:raw` key), bounded by `maxEntries` (default 200, hard cap 1000), and adds a route-local `format=text` rendering for LLM contexts alongside `full` and `table`. The compaction is the pure `buildSessionNarrative` / `renderSessionNarrativeText` in `@uptimizr/db`; its shapes, defaults and caps live in `@uptimizr/metrics`, which also gains the `session_narrative` registry entry and an `endpoint.capability` field. `@uptimizr/agent-core` splits the generated catalog into `readTools` (the `query` surface, unchanged) and a new `rawTools`, and `createMcpServer(client, { capabilities })` registers the latter only for a key that really holds `query:raw` — the `uptimizr-mcp` binary discovers that from `/api/v1/whoami` at start-up. A narrative is a projection, never the stream: no visitor hash, URL or page metadata, no positions or rays, no device detail beyond the rendering engine, and custom-event property keys only (ADR 0003).
- 395aa36: Project context resource, custom-event vocabulary and assistant prompt injection (ADR 0051 §5).

  `GET /api/v1/context` (and the MCP `uptimizr://context` resource) describes the project an agent is
  looking at in one bounded, briefly-cached read: scenes with their labels and named regions, the
  discovered custom-event vocabulary with observed prop keys and coarse types, top meshes and bound
  input actions, capture channels seen, data freshness and retention flags, the store engine and
  versions, and the metrics that will return empty because every capture channel feeding them is off.

  A new `custom_event_vocabulary` metric (`GET /api/v1/vocabulary/custom-events`) serves the vocabulary
  on its own and becomes a generated agent tool. The in-browser assistant fetches the context and
  injects a compact rendering (`renderContextForPrompt` in `@uptimizr/agent-core`) into its system
  prompt, degrading silently against a collector too old to serve it.

### Patch Changes

- 375cb7c: Refresh runtime dependencies across the workspace: Zod 4.6.5 (every package that validates at a boundary), Fastify 5.12.5 and `@fastify/static` 10.1.4 (collector-server), `@duckdb/node-api` 1.5.5-r.5 (db), `mssql` 12.7.2 (db-mssql), and Next.js 16.3.5, Babylon.js 9.27.1 and WebLLM 0.2.85 (dashboard). No API or behaviour changes; `pnpm audit` stays clean.
- e1213c8: Packaged agent docs: repair the contradictory fragments the wave-2 integration merge left behind.
  Every duplicated paragraph or bullet now appears once, with the statement that is actually true of
  this release: five insight primitives rather than three or four, one `Types:` line in
  `@uptimizr/metrics`' `llms.txt` instead of three, one `query:raw` paragraph in `@uptimizr/mcp`'s
  guide instead of two that disagreed about whether `session_narrative` exists, and the packaged
  skill names spelled as they ship (`xr_comfort_audit`, plus `conversion_investigation` and
  `performance_regression_triage`). Tool and metric counts are recomputed from the registry — 78
  metrics, 76 served on a read endpoint, 77 tools on a plain `query` key — and the "read-only"
  claims now say what they mean: events are read-only, metadata writes need `annotate`, and
  `session_narrative` needs `query:raw`.
- 969c899: `GET /api/v1/timeseries` no longer 500s on a bucket that has events but no
  `frame_perf` sample.

  `avg` over an empty set is SQL-NULL, so any minute with traffic and no perf
  telemetry made the store report `avg_fps: null` — while the metric registry
  declared the column non-nullable. The Zod response serialiser rejected the row
  and the whole request failed with `FST_ERR_RESPONSE_SERIALIZATION`, which the
  dashboard's event-volume panel rendered as "Could not load", taking the
  annotation markers on its time axis down with it.

  `timeseries.avg_fps` is now `numOrNull`, the registry's own convention for an
  aggregate over a possibly-empty set: `null` means "no samples", never `0`. Two
  stores were 0-filling it against that convention and now agree with the SQL
  ones — the collector's in-memory store, and ClickHouse, whose `avgIf` reports
  `0` where every other dialect's `FILTER` / `CASE` form reports NULL (it now
  renders `avgIfOrNull`). The dashboard already read the column as
  `avg_fps ?? 0`, so nothing changes on screen.

- Updated dependencies [f5fc7b6]
- Updated dependencies [375cb7c]
- Updated dependencies [395aa36]
- Updated dependencies [e1213c8]
- Updated dependencies [395aa36]
- Updated dependencies [395aa36]
- Updated dependencies [395aa36]
  - @uptimizr/schema@1.2.0

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

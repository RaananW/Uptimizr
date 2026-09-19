# @uptimizr/collector-server

## 2.2.0

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

- 395aa36: The project context document (`GET /api/v1/context`) now reports the project's
  real glossary and recent annotations.

  `#308` shipped the document with a narrow `ProjectMetadataProvider` seam and an
  empty default, because the metadata write path did not exist yet; `#310` shipped
  that path with `listGlossary(projectId)` and `listAnnotations(projectId, { limit })`
  named for exactly this hook-up. `buildApp` now defaults to
  `storeProjectMetadata(store)`, so a term written with `PUT /api/v1/glossary/:term`
  appears in `definitions.glossary`, and a note left with `POST /api/v1/annotations`
  appears in `annotations.recent`, with no route, schema or client change.

  Reading the context still needs only `query` — writing is the metadata route's
  job and keeps its own `annotate` gate. `EMPTY_PROJECT_METADATA` remains exported
  for an embedder with no metadata store, and `buildApp` still accepts a
  `projectMetadata` override.

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

- 395aa36: Serve MCP over Streamable HTTP at `/mcp` behind `COLLECTOR_MCP_HTTP=1` (off by default), so a remote
  AI client connects to a self-hosted collector with a URL and an API key instead of running the stdio
  server locally (ADR 0051 §7). Every request is authenticated with `x-api-key` or
  `Authorization: Bearer`, sessions are capped by `COLLECTOR_MCP_MAX_SESSIONS` and expire after
  `COLLECTOR_MCP_SESSION_TTL_MS`, and tool calls are audited with `surface: "mcp-http"`.
  `createMcpServer` gains an optional `options.capabilities` so a hosted session's surface can match
  its key; the stdio entry point is unchanged.
- 395aa36: `uptimizr agent report` — headless, scheduled analytics reports (ADR 0051 §6).

  A new collector CLI subcommand runs the headless `runAgent` loop **once**, in the operator's own
  process, over the generated read-only tool catalog against the collector's query API, and writes a
  Markdown report to a file, stdout or a signed webhook:

  ```bash
  uptimizr agent report --skill weekly_scene_health --scene lobby --window 7d \
    --out report.md --json report.json --webhook https://hooks.example.com/uptimizr
  ```

  The collector gains no in-process LLM loop and scheduling stays the operator's (cron, a systemd
  timer, a GitHub Action). Provider configuration is read from the environment only and never
  persisted, and the provider key never reaches a log, a report or an error message. The system
  prompt carries the rendered `GET /api/v1/context` document, and every report ends with a **Method**
  section listing each tool call and its arguments, so an unattended, model-written document stays
  auditable. `--dry-run` prints the exact prompt without calling a provider, and
  `UPTIMIZR_AGENT_PROVIDER=scripted` exercises the whole path with no model, no key and no egress.

  `@uptimizr/agent-core` gains the pieces both clients now share: `AGENT_SKILLS` (the curated
  investigations, previously inlined in `@uptimizr/mcp`'s prompt templates, which now register from
  them), the `ANALYTICS_AGENT_GUIDELINES` / `renderCurrentTimeLine` system-prompt fragments the
  browser assistant already used, and an optional `ProviderResponse.usage` that the hosted adapters
  fill from the provider's own token accounting. No prompt text changes for any existing consumer.

- 395aa36: Add the **metadata write path** — annotations, a project glossary and saved analyses — so people
  and agents can leave something behind instead of re-deriving it every session. Events stay
  read-only; these are the only rows a request can write besides ingestion, and every write needs a
  key holding the `annotate` capability and is recorded in the agent audit log (ADR 0051 §5/§9).

  - `@uptimizr/schema`: `annotationSchema` (`targetKind: project|scene|mesh|region|metric|window`,
    optional `targetId`, `since`/`until`, bounded `text`), `glossaryEntrySchema`,
    `savedAnalysisSchema` and `metadataAuthorKindSchema` — config/metadata shapes, deliberately
    outside the event union — plus the per-field and per-project bounds in `LIMITS`.
  - `@uptimizr/db` and the optional Postgres / SQL Server / ClickHouse stores: `annotations`,
    `glossary` and `saved_analyses` tables (forward-only, idempotent migrations) with
    `createAnnotation` / `listAnnotations` / `deleteAnnotation`, `putGlossaryEntry` / `listGlossary` /
    `deleteGlossaryEntry` and `createSavedAnalysis` / `listSavedAnalyses` / `deleteSavedAnalysis`.
    Each store enforces the per-project caps (500 annotations, 200 glossary terms, 200 analyses) at
    write time and throws `MetadataLimitError` when a project is full.
  - `@uptimizr/collector-server`: `GET`/`POST`/`DELETE /api/v1/annotations[/:id]`,
    `GET /api/v1/glossary` with `PUT`/`DELETE /api/v1/glossary/:term`, and
    `GET`/`POST`/`DELETE /api/v1/analyses[/:id]`. Writes require `annotate`, reads `query`; payloads
    are Zod-bounded at the edge and a full project answers `409`. Stored rows record whether a person
    or an agent wrote them, decided from the calling client rather than the payload. The served
    OpenAPI document describes the whole group.
  - `@uptimizr/agent-core` and `@uptimizr/mcp`: a new `writeTools` catalog (`annotate`, `define_term`,
    `save_analysis`, plus `list_annotations`, `list_glossary`, `list_analyses`), kept a **separate
    export** from the read-only `readTools` so an integration's read-only stance stays inspectable.
    The MCP server calls `GET /api/v1/whoami` at start-up and registers them only when the key holds
    `annotate`; the collector client gains `post`/`put`/`delete` used by these tools alone.
  - `@uptimizr/react`: `CollectorApi.whoami` / `.annotations` / `.createAnnotation` / `.glossary` /
    `.defineTerm` / `.analyses` / `.saveAnalysis`, the assistant actions "Annotate this" and "Save
    this analysis" (shown only for an `annotate` key), `annotationTargetFor(filters)`, and annotation
    markers on the event-volume time axis.
  - `@uptimizr/dashboard`: the assistant drawer passes the active filters through, so an
    "Annotate this" note is pinned to the scene or window the user is looking at.

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
- 785761d: Spatial labelling on `format=summary`: world-space heatmap hotspots now carry `region` (the smallest
  containing scene region), `regions[]`, `nearestMesh` and `distance`, the `reading` names the place,
  and `drill.region` becomes the region id. The 3D panels show the same labels on hover.
- 395aa36: Conditional subscriptions, an SSE stream and signed webhooks (ADR 0051 §6). A subscription names a
  registry metric, a window and a predicate — `threshold`, `anomaly`, `movers`, `new_value` or
  `presence` — and the collector evaluates it in-process on a bounded scheduler, records each firing
  in a per-subscription log and delivers it over SSE and/or an HMAC-signed webhook. Webhook egress is
  disabled until `COLLECTOR_WEBHOOK_ALLOWED_HOSTS` names the hosts the collector may reach, and a
  webhook secret is write-only. Adds `/api/v1/subscriptions*`, a read-only dashboard panel, a
  `list_subscriptions` agent tool and `uptimizr subscriptions list|add|remove|test`.
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
- 07d4f60: Packaged methodology skills (ADR 0051 §7)

  A prompt that names tools still leaves the method to the model. A **skill** carries the
  method: an Agent Skills file — `skills/<name>/SKILL.md` — whose frontmatter declares the
  tools it relies on, the key capabilities it needs and the arguments it takes, and whose
  body is the investigation written out as numbered steps.

  Five ship, in both the `@uptimizr/agent-core` and `@uptimizr/mcp` tarballs:

  - **`weekly_scene_health`** — the recurring health check: score first, then what moved,
    whether the new level is outside baseline, whether the change is real, and the date the
    anomaly scan puts on it.
  - **`attention_hotspots`** — where attention concentrates in a scene, and the cold half:
    dwell without interaction, and the meshes nobody ever notices.
  - **`conversion_investigation`** _(new)_ — where a funnel loses people and why: the bounce
    before the first step, the worst transition, and the interaction failure (dead clicks,
    rage clicks, an unreachable target) that usually _is_ the drop-off.
  - **`performance_regression_triage`** _(new)_ — confirm, date, locate, then name the
    mechanism: jank versus a uniform slowdown, compile stalls, memory pressure, a
    render-scale change or a shift in the rendering-technology mix.
  - **`xr_comfort_audit`** — rapid rotation, locomotion style and early exits, with tracking
    loss and guardian contacts ruled out first.

  The files are the source of truth. `scripts/gen-agent-skills.mjs` compiles them into
  `skills.generated.ts`, so `AGENT_SKILLS` is derived from them and `@uptimizr/agent-core`
  stays browser-safe (nothing reads them from disk at runtime). `pnpm gen:skills:check` is
  the CI gate that fails a hand-edited generated file.

  Every surface reads the same text: `@uptimizr/mcp` registers one prompt template per skill
  and adds a **`uptimizr://skills`** resource listing the catalog, `uptimizr agent report
--skill` runs one headlessly (and now fills the skill's `range` from `--window`), and the
  `@uptimizr/react` assistant offers the argument-free ones as starter prompts.

  `getAgentSkill(name)` accepts either spelling — `xr_comfort_audit` or `xr-comfort-audit` —
  and `AgentSkill` gains `id` and `capabilities`. The XR skill was widened from comfort
  signals to a full audit and renamed `xr_comfort_review` → `xr_comfort_audit`; the old name
  still resolves, so saved prompt references and cron lines keep working.

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

- Updated dependencies [395aa36]
- Updated dependencies [395aa36]
- Updated dependencies [395aa36]
- Updated dependencies [395aa36]
- Updated dependencies [0c7507d]
- Updated dependencies [395aa36]
- Updated dependencies [395aa36]
- Updated dependencies [e1213c8]
- Updated dependencies [07d4f60]
- Updated dependencies [395aa36]
- Updated dependencies [395aa36]
- Updated dependencies [395aa36]
- Updated dependencies [785761d]
- Updated dependencies [785761d]
- Updated dependencies [395aa36]
- Updated dependencies [969c899]
- Updated dependencies [395aa36]
  - @uptimizr/metrics@0.2.0
  - @uptimizr/db@2.1.0
  - @uptimizr/agent-core@1.2.0
  - @uptimizr/mcp@1.2.0
  - @uptimizr/db-clickhouse@2.1.0
  - @uptimizr/db-postgres@2.1.0
  - @uptimizr/db-mssql@2.1.0
  - @uptimizr/schema@1.2.0

## 2.1.0

### Minor Changes

- 3215c56: `uptimizr init` and `uptimizr new-project` now mint the operator's first key as an **owner key** —
  `query`, `query:raw` and `annotate`, labelled `owner` — instead of `query` alone, and print the
  capability set next to the key. That is the key that drives the dashboard, session replay, the live
  per-session follow and scene regions, so switching `ENABLE_RAW_SESSION_RETENTION` on no longer
  makes replay answer `403` until a second key is minted and swapped in. `query:raw` grants nothing on
  its own: the raw routes need both halves of the gate. `uptimizr new-key` is unchanged and still
  defaults to `query`, which is the key to hand an agent or MCP client — `init` now prints that hint.
  `pnpm db:seed` grants the demo projects the same three capabilities, matching the repo's other
  local provisioning scripts.

### Patch Changes

- Updated dependencies [3215c56]
  - @uptimizr/db@2.0.1
  - @uptimizr/db-clickhouse@2.0.2
  - @uptimizr/db-mssql@2.0.2
  - @uptimizr/db-postgres@2.0.2

## 2.0.1

### Patch Changes

- 1123bfe: Ship AGENTS.md and llms.txt in the tarball (ADR 0017)
- Updated dependencies [1123bfe]
  - @uptimizr/db-clickhouse@2.0.1
  - @uptimizr/db-postgres@2.0.1
  - @uptimizr/db-mssql@2.0.1

## 2.0.0

### Major Changes

- a6d87b1: Agent-scoped API keys: capability sets, per-key rate limits, an audit log and `whoami` (#309, ADR 0051 §7).

  **Breaking — raw per-session access now needs `query:raw`.** `GET /api/v1/sessions/:id/events` and the live per-session follow `GET /api/v1/live/sessions/:id` require **both** `ENABLE_RAW_SESSION_RETENTION` on the collector and the new `query:raw` capability on the key; previously retention alone was enough for any `query` key. Existing keys keep working for every aggregate endpoint and need no migration, but a key that drives session replay or live-follow must be re-minted with `uptimizr new-key <projectId> --capabilities query,query:raw`.

  **Breaking — `@uptimizr/db` metadata contracts.** `ApiKeyCapability` grows from `"ingest" | "query"` to `"ingest" | "query" | "annotate" | "query:raw"`. `ApiKeyRecord` and `ResolvedApiKey` replace the singular `capability` field with `capabilities: ApiKeyCapability[]`, and gain `label` plus a nullable `rateLimit`; `ResolvedApiKey` also carries `keyId`. `createApiKey(client, projectId, capability?)` now takes an options object (`{ capabilities, label, rateLimit }`) on all four engines. Each store package gains `recordAudit` / `listAudit` / `pruneAudit`.

  - Migrations on DuckDB, Postgres, SQL Server and ClickHouse add `capabilities`, `label`, `rate_limit_max`, `rate_limit_window_ms` and an `agent_audit` table. They are forward-only, additive and idempotent (ADR 0007); the legacy `capability` column is untouched and still feeds the read path as a fallback, so keys issued before this release resolve unchanged.
  - Per-key rate limits (`uptimizr new-key --rate-limit-max N --rate-limit-window-ms M`) bucket on the key id instead of the client IP; keys without one keep the global `COLLECTOR_RATE_LIMIT_*` defaults. Keyless ingest is unaffected.
  - `GET /api/v1/whoami` reports the calling key's project, key id, capabilities, label and effective rate limit. `GET /api/v1/audit` (`since`/`until`/`limit`, `query` capability) serves the agent audit trail: key id, route pattern, bounded and redacted params, row count, duration and status, written asynchronously and expiring after `AUDIT_RETENTION_DAYS` (default 30).
  - New CLI: `uptimizr new-key <projectId> [--capabilities …] [--label …] [--rate-limit-max N --rate-limit-window-ms M]`. `init` and `new-project` keep minting read-only `query` keys; `uptimizr-db-new-project` gains a `--capabilities` flag.
  - `@uptimizr/react`'s `CollectorApi` takes an optional third `client` argument (default `"dashboard"`) and sends it as `x-uptimizr-client`, which is how the collector tells a dashboard's panel refreshes apart from agent traffic in the audit log. Existing two-argument construction is unchanged.

### Minor Changes

- 018054b: Generate the collector's self-description from the semantic metric registry (ADR 0051 §1).

  - **`@uptimizr/collector-server`** serves a new, unauthenticated
    `GET /api/v1/openapi.json`: an OpenAPI 3.1 document built from the metric registry and the
    server's own route table, so every path, parameter schema and response schema comes from the
    code that actually serves and validates the request. Semantics OpenAPI cannot express —
    result grain, per-column units, caveats, interpretation, capture channels, row limits,
    dimensions, related metrics and comparison direction — ride along as `x-uptimizr-*` vendor
    extensions. Rate-limited like every other route; it contains no project data.
  - **`@uptimizr/mcp`**'s `uptimizr://capabilities` resource is now built from the registry and
    gains a `metrics` array: the whole registry minus the SQL builder, with each row schema as
    JSON Schema. Existing keys (`schemaVersion`, `readOnly`, `eventTypes`, `params`, `tools`,
    `notes`) are unchanged.
  - The tool/endpoint tables in the packaged `README.md`, `AGENTS.md` and `llms.txt` of
    **`@uptimizr/mcp`** and **`@uptimizr/agent-core`** are now rendered from the registry by
    `scripts/gen-registry-docs.mjs`, with a CI staleness gate (`pnpm gen:docs:check`).

- e378214: Add a shared `format=full | table | summary` envelope to every aggregate query endpoint (ADR 0051 §2).

  `format` filters nothing — it selects the shape the rows come back in. **`full` is the default and
  is unchanged**, byte for byte, so the dashboard and every existing client are unaffected (a sweep
  over the parity fixtures asserts each endpoint's default body still hashes to what it returned
  before this change). `table` keeps the rows and adds a `meta` envelope: the metric, the requested
  range, the applied filters, the sample size, the row count, whether the row cap truncated the
  result, and the registry limits. `summary` returns a **bounded** digest capped at the metric's
  `limits.maxSummaryRows`, so a 500-bin heatmap costs an agent the same number of tokens as a 5-bin
  one.

  `@uptimizr/db` gains the summariser behind it on a new browser-safe `@uptimizr/db/summary` subpath
  (also re-exported from the package root): `summarizeRows(metric, rows, ctx)`,
  `tableResult(metric, rows, ctx)`, the `clusterCells` spatial helper, `wilsonInterval`, and Zod
  schemas for all three envelopes. It is pure and registry-driven — the metric's `grain` picks the
  shape: ranked `top[]` rows with shares and a `rest` bucket for a leaderboard; a
  `first / last / min / max / trend / slope` series for a `bucket` grain; deterministic greedy-merged
  clusters (8-neighbourhood for 2D bins, 26 for voxels, ranked by summed weight, each reporting
  centroid, extent, cells, weight and share) for `bin` and `voxel` grains; and the row itself plus its
  `rateOf` rates for a single-row metric. Every summary carries a sample size derived from the
  registry's column units, the metric's caveats plus any true only of that result, `drill` hints
  naming filters the metric actually accepts, and a `reading` sentence templated from column semantics
  alone — no model is involved, so the same rows always produce the same words. Shares, `total` and
  the Wilson `confidence` note are reported only where the measure's unit can honestly be summed.

  Registry additions: `"format"` is a `FilterId` and is declared on all 67 metrics served on a
  querystring endpoint, and `ColumnSemantics` gains an optional `axis` flag marking the ordered column
  of a `bucket`-grain metric (`label` cannot double as the axis — `mesh_trend` labels its rows by
  mesh). Each affected route's 200 response schema is now the union of the three envelopes, with the
  untouched `full` shape first.

- 2f1a753: Add **scene regions** — named, labelled world-space boxes that give a scene a shared vocabulary
  for _where_ things happen ("the entrance", "the checkout counter").

  - `@uptimizr/schema`: `sceneRegionSchema` / `sceneRegionsSchema` (config, deliberately outside the
    event union) plus the `maxSceneRegionLabelLength` / `maxSceneRegionDescriptionLength` /
    `maxSceneRegions` bounds.
  - `@uptimizr/db` and the optional Postgres / SQL Server / ClickHouse stores: a `scene_regions`
    metadata table (forward-only, idempotent migration) keyed `(project_id, scene_id, region_id)`,
    with `putSceneRegions` (replaces a scene's whole set atomically), `getSceneRegions` and
    `listSceneRegions`.
  - `@uptimizr/collector-server`: `PUT` / `GET /api/v1/scenes/:sceneId/regions`, the project-wide
    `GET /api/v1/scene-regions` listing, `uptimizr regions set|get` CLI commands, and `region=<id>`
    as an alternative to the six-number box on every spatial endpoint that already takes a region
    (resolved server-side to the stored bounds; an unregistered id is a `400`). The region reads
    take a `query`-capable key; the **write** takes an `annotate`-capable one (a `query`-only key
    is refused with `403`). `uptimizr regions set` opens the store directly and needs no key.
  - `@uptimizr/sdk-core`: `registerRegions(sceneId, regions, { endpoint, apiKey })`, the authoring
    counterpart to a connector's `scanSceneProxy`.

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

- fa489c1: Read the metric registry from `@uptimizr/metrics` instead of the removed `@uptimizr/db/registry`
  subpath. `GET /api/v1/openapi.json` and the registry route checks are unchanged — same 69 metrics,
  same document.
- Updated dependencies [a6d87b1]
- Updated dependencies [fa489c1]
- Updated dependencies [d1d8f7c]
- Updated dependencies [fa489c1]
- Updated dependencies [e378214]
- Updated dependencies [2f1a753]
- Updated dependencies [ee1b7c7]
  - @uptimizr/db@2.0.0
  - @uptimizr/db-clickhouse@2.0.0
  - @uptimizr/db-mssql@2.0.0
  - @uptimizr/db-postgres@2.0.0
  - @uptimizr/metrics@0.1.0
  - @uptimizr/schema@1.1.0

## 1.1.1

### Patch Changes

- 3c3ee66: Make the package scripts cross-platform so a fresh Windows checkout can build. `clean` now uses `rimraf` instead of `rm -rf`, and the dashboard's `build`/`build:static`/`prepack`/`start` no longer rely on a POSIX `VAR=value` prefix. No runtime or published-output change.
- Updated dependencies [3c3ee66]
- Updated dependencies [3c3ee66]
  - @uptimizr/db@1.0.2
  - @uptimizr/db-clickhouse@1.0.2
  - @uptimizr/db-mssql@1.0.2
  - @uptimizr/db-postgres@1.0.2
  - @uptimizr/schema@1.0.1

## 1.1.0

### Minor Changes

- f44c175: `uptimizr init`, `uptimizr new-project` and `uptimizr migrate` now honour `COLLECTOR_STORE`
  (`duckdb` | `postgres` | `mssql` | `clickhouse`), bootstrapping the selected store through the same
  connection variables `serve` reads (`DUCKDB_PATH`, `POSTGRES_URL`, `MSSQL_URL`, `CLICKHOUSE_*`, …)
  instead of always targeting DuckDB. The project and key minted by `init` are therefore the ones the
  running collector resolves, and `init` records the selected store (plus any connection variables
  that were set) in the `.env` it writes. `COLLECTOR_STORE=memory` and unknown values now fail with an
  actionable error. Pairs with `create-uptimizr --store <s>` (#267).

### Patch Changes

- a2c75cd: Refresh runtime dependencies: Fastify 5.12.3 (collector-server) and Next.js 16.3.4 (dashboard). The workspace lockfile now resolves `qs` 6.16.0, clearing GHSA-x5fp-wj9c-mxmx and GHSA-4mjr-xmp4-gh2g.

## 1.0.1

### Patch Changes

- Updated dependencies [cd44b11]
  - @uptimizr/db@1.0.1
  - @uptimizr/db-clickhouse@1.0.1
  - @uptimizr/db-mssql@1.0.1
  - @uptimizr/db-postgres@1.0.1

## 1.0.0

### Major Changes

- 9dd78e8: Uptimizr 1.0.0 — first stable release. Every package moves to 1.0.0 together; from here on the public API, the versioned event schema, and the collector's HTTP API follow semantic versioning (a breaking change is a major). Highlights since the public beta: six stable live-JS connectors (Babylon.js, Babylon Lite, three.js, react-three-fiber, PlayCanvas, A-Frame/WebXR) with per-engine capture parity and end-to-end coverage; WebXR in-scene hit resolution; three optional multi-writer stores (ClickHouse, PostgreSQL, SQL Server) behind the same `CollectorStore` contract with cross-engine parity tests; the in-browser analytics assistant with a local (WebLLM) or hosted model, tool-calling over the read-only analytics catalog, and streamed replies; and the MCP server for desktop AI clients. No wire-format or API changes are bundled with this bump — it marks the point where they become breaking.

### Patch Changes

- 29c167d: `COLLECTOR_STORE=mssql` selects the new single-tenant Microsoft SQL Server store
  (`@uptimizr/db-mssql`, #85) — connection from `MSSQL_URL` or the discrete `MSSQL_SERVER` /
  `MSSQL_PORT` / `MSSQL_DATABASE` / `MSSQL_USER` / `MSSQL_PASSWORD` settings; the database is created
  on first boot when the login may. No change to routes, schema contracts, or the dashboard.
- fceff6c: `COLLECTOR_STORE=postgres` selects the new single-tenant Postgres store (`@uptimizr/db-postgres`,
  #84) — connection from `POSTGRES_URL` (or `DATABASE_URL`), optional `POSTGRES_SCHEMA` /
  `POSTGRES_POOL_MAX`. No change to routes, schema contracts, or the dashboard.
- Updated dependencies [29c167d]
- Updated dependencies [29c167d]
- Updated dependencies [fceff6c]
- Updated dependencies [fceff6c]
- Updated dependencies [9dd78e8]
  - @uptimizr/db@1.0.0
  - @uptimizr/db-mssql@1.0.0
  - @uptimizr/db-postgres@1.0.0
  - @uptimizr/schema@1.0.0
  - @uptimizr/db-clickhouse@1.0.0

## 0.8.0

### Minor Changes

- 0af8209: `COLLECTOR_TRUST_PROXY` no longer accepts a bare hop count and now fails at startup with an explanatory error if one is set.

  Fastify 5.12.1 disabled numeric hop-count trust: a hop count cannot validate the immediate peer, so a client talking to the collector directly could spoof `X-Forwarded-*` by supplying enough hops. Fastify now fails closed on a number and silently ignores the forwarded headers — which would quietly bucket the cookieless visitor hash and the rate limiter on the proxy's IP instead of the client's.

  **Action required** if you set a hop count (e.g. `COLLECTOR_TRUST_PROXY=1`): name the trusted proxy instead — a single IP, a CIDR, or a comma-separated list (`COLLECTOR_TRUST_PROXY=10.0.0.0/8`), or `true` when the collector is not directly reachable. Deployments that leave it unset, or already set `true`/an IP list, are unaffected.

### Patch Changes

- 0af8209: Update runtime dependencies: Fastify 5.12.1 and @fastify/helmet 13.1.1 (collector-server), Next.js 16.3.3 and Babylon.js 9.23.0 (dashboard), and Zod 4.5.4 (schema, agent-core, mcp, replay, collector-server). Dev-only dependency bumps across the remaining packages are not released.
- Updated dependencies [0af8209]
  - @uptimizr/schema@0.6.1
  - @uptimizr/db@0.8.2
  - @uptimizr/db-clickhouse@0.3.8

## 0.7.1

### Patch Changes

- db76d60: Update runtime dependencies: Fastify 5.12 / @fastify/static 10.1.3 (collector-server), Next.js 16.3.1, Babylon.js 9.21.2 and WebLLM 0.2.84 (dashboard), and DuckDB node-api 1.5.5-r.4 (db). Dev-only dependency bumps across the remaining packages are not released.
- Updated dependencies [db76d60]
  - @uptimizr/db@0.8.1
  - @uptimizr/db-clickhouse@0.3.7

## 0.7.0

### Minor Changes

- 6d883d0: Add guardian / boundary-touch spatial analytics for room-scale VR (#157, ADR 0048).

  - **schema:** new `xr_boundary_proximity` event — a coarse voxel-binned `position` (HMD position at
    the closest approach) plus `durationMs` (time within the near-boundary zone). One event per
    approach; count is implied by frequency.
  - **sdk-babylon:** opt-in `babylonBoundaryCollector` detects, entirely on-device, when the tracked
    WebXR pose comes within a near threshold (default 0.5 m) of a bounded reference space's guardian
    boundary and emits one event per approach. The boundary polygon / room geometry is **never**
    transmitted (ADR 0003 / ADR 0048).
  - **@uptimizr/db:** dialect-agnostic `buildBoundaryHeatmap`, `buildBoundaryHeatmapStats`, and
    `buildBoundaryContacts` builders that reuse the existing world-heatmap voxel path (no migration —
    the promoted `position` column is reused).
  - **collector-server:** new `GET /api/v1/heatmaps/boundary`, `/api/v1/heatmaps/boundary/stats`, and
    `/api/v1/xr/boundary-contacts` endpoints.
  - **@uptimizr/react:** a boundary-touch heatmap panel (3D, reusing the world-heatmap render path) and
    a per-session guardian boundary-contacts comfort panel, both registered in the OSS panel catalog.

### Patch Changes

- fa842eb: Update runtime dependencies to their latest releases: Fastify and its rate-limit
  plugin (collector-server), Babylon.js core and loaders (dashboard), and the DuckDB
  Node API (db). Development-only tooling across the workspace was refreshed to latest
  as well; TypeScript is intentionally held back pending the 7.x migration.
- c84fec4: Resolve three security advisories in transitive runtime dependencies by tightening the
  workspace overrides: `brace-expansion` to `>=5.0.9` (GHSA-rgw5-rvv9-x895, denial of service
  via unbounded intermediate arrays — reached through `@fastify/static`), `fast-uri` to
  `>=3.1.5` (GHSA-7p8r-x3mc-p8w7, host confusion via a backslash authority introducer — reached
  through Fastify and the MCP SDK), and a new `hono` override at `>=4.12.34`
  (GHSA-8j4g-w8fx-2239, regular-expression denial of service in the CORS middleware — reached
  through the MCP SDK). No API or behavior changes.
- Updated dependencies [0e8b8a8]
- Updated dependencies [6d883d0]
- Updated dependencies [fa842eb]
- Updated dependencies [8041ca2]
  - @uptimizr/schema@0.6.0
  - @uptimizr/db@0.8.0
  - @uptimizr/db-clickhouse@0.3.6

## 0.6.3

### Patch Changes

- Updated dependencies [1bb9846]
  - @uptimizr/db@0.7.3
  - @uptimizr/db-clickhouse@0.3.5

## 0.6.2

### Patch Changes

- 59fd29b: docs: refresh package and app READMEs to match current source

  Reconcile every package/app README with the actual code — corrected package/connector
  lists, public APIs and options, CLI flags, env vars, ports, the event catalog, and
  cross-links. Also drop "Google Analytics" references in favor of neutral "web analytics"
  wording. Documentation-only; no runtime behavior changes.

- Updated dependencies [e31ff64]
- Updated dependencies [59fd29b]
  - @uptimizr/db-clickhouse@0.3.4
  - @uptimizr/db@0.7.2
  - @uptimizr/schema@0.5.1

## 0.6.1

### Patch Changes

- Updated dependencies [a7aad24]
  - @uptimizr/db@0.7.1
  - @uptimizr/db-clickhouse@0.3.3

## 0.6.0

### Minor Changes

- 4751b5d: feat: path-retrace / backtracking-ratio leaderboard (#153). Adds a new derived
  metric — computed from the existing `camera_sample` position stream, with **no
  schema change** — that ranks scenes/areas by how often visitors re-walk the same
  area (a confusion signal desire lines don't surface).

  - `@uptimizr/db`: new `buildBacktrackRatio(projectId, opts, dialect)` aggregation
    and `BacktrackRatioRow` type. It bins positions onto a coarse X/Z grid
    (`cellSize`, default 2 world units), collapses consecutive dwell samples in one
    cell into ordered _cell entries_ via the `asofLeftJoin` predecessor pattern, and
    pools `backtrack_ratio = revisits ÷ entries` per scene. Cross-engine safe
    (DuckDB + ClickHouse): uses only plain `count()` + a distinct-cell dedup
    subquery and the `present` sentinel for ASOF-LEFT misses. Added to the parity
    suite with golden output.
  - `@uptimizr/collector-server`: new `GET /api/v1/backtrack` query route
    (`cellSize`, `limit`, `scene`, `session`) plus the `backtrackRatio` store method
    across the DuckDB, ClickHouse, and memory stores.
  - `@uptimizr/react`: new `backtrackRatio()` API client method, `BacktrackRatioStat`
    type, and a **Backtracking hotspots** leaderboard panel (`backtrack-ratio`)
    registered in `ossPanelCatalog` and exported individually.

  Additive and non-breaking — every existing export keeps working.

- 541c97a: feat(perf): perf-driven churn overlay — correlate FPS dips / compile stalls with early session end (#144)

  Adds a buildable-now "perf-correlated churn rate": of the sessions that ended in
  range, the share that ended shortly after an FPS dip (a `frame_perf` sample below
  a threshold) or a `compile_stall`, within a configurable window, split by cause.

  - `@uptimizr/db`: new dialect-agnostic `buildPerfChurn` aggregation (`PerfChurnRow`)
    derived from existing `frame_perf`, `compile_stall`, `session_end` events — no
    schema change; DuckDB + ClickHouse safe (no window/ASOF functions).
  - `@uptimizr/collector-server`: new `GET /api/v1/perf/churn` endpoint
    (`windowMs` / `fpsThreshold` / `stallMs` params) and `Store.perfChurn`.
  - `@uptimizr/react`: `CollectorApi.perfChurn` + the "Perf-driven churn" dashboard
    panel with viewer-tunable window / FPS / stall settings.

- 31ae82b: feat(db,collector,react): reachability report — per-mesh interaction-distance histogram (#151)

  Adds a buildable-now `buildReachability` query that ASOF-joins each `mesh_interaction`
  world point to the nearest preceding `camera_sample` and histograms the standpoint→interaction
  distance per mesh, surfaced through `GET /api/v1/meshes/reachability`, the `@uptimizr/react`
  client, and a new **Reachability report** OSS panel. No schema change.

- ab4e3c5: feat(dashboard,db): 360° view-coverage gauge per session (#146)

  Add a derived per-session **view-coverage** metric: bin each session's
  `camera_sample` directions into the same azimuth/elevation grid as the
  view-direction dome, and report the fraction of cells visited as a 0–100%
  coverage score. Sessions are aggregated into a histogram of 25%-wide coverage
  bands (0–25 / 25–50 / 50–75 / 75–100%) — "how many visitors never rotated the
  product to see the back".

  - `@uptimizr/db`: new `buildViewCoverageHistogram` query builder + `ViewCoverageHistogramRow`.
  - `@uptimizr/collector-server`: new `GET /api/v1/coverage/view-histogram` read endpoint.
  - `@uptimizr/react`: new `viewCoverageHistogram` API client method and the **View coverage**
    dashboard panel.

  No schema change — entirely derived from the existing `camera_sample` stream.

### Patch Changes

- Updated dependencies [4751b5d]
- Updated dependencies [e39cbc7]
- Updated dependencies [3c0a20b]
- Updated dependencies [db331a3]
- Updated dependencies [de0836d]
- Updated dependencies [3193a21]
- Updated dependencies [541c97a]
- Updated dependencies [31ae82b]
- Updated dependencies [53a4695]
- Updated dependencies [b0ac76e]
- Updated dependencies [ab4e3c5]
- Updated dependencies [872d4b2]
  - @uptimizr/db@0.7.0
  - @uptimizr/schema@0.5.0
  - @uptimizr/db-clickhouse@0.3.2

## 0.5.1

### Patch Changes

- Updated dependencies [08c4abd]
- Updated dependencies [a580f5e]
- Updated dependencies [c8887f7]
- Updated dependencies [d71b284]
  - @uptimizr/schema@0.4.0
  - @uptimizr/db@0.6.0
  - @uptimizr/db-clickhouse@0.3.1

## 0.5.0

### Minor Changes

- fa6c472: Add a browser/OS performance segment derived from the request User-Agent at
  ingestion (#11). The collector reduces the User-Agent to a coarse, non-PII
  `{ browser, os }` pair (raw UA never stored) and merges it into
  `session_start.device`; `buildPerfByDevice` and the dashboard "FPS by device"
  panel now segment per-session median FPS by browser/OS in addition to graphics
  backend, mobile flag, and GPU renderer. No SDK, schema-capture, or storage
  migration change (ADR 0041).

### Patch Changes

- Updated dependencies [fa6c472]
- Updated dependencies [32248e0]
  - @uptimizr/schema@0.3.0
  - @uptimizr/db@0.5.0
  - @uptimizr/db-clickhouse@0.3.0

## 0.4.0

### Minor Changes

- b5c7eac: feat(heatmaps): large-scene spatial resolution (ADR 0040)

  Make scenes that are much larger than their walkable area legible without forcing manual
  `setScene` segmentation. Four additive, non-breaking pillars:

  - **Bounds-driven `cellSize`** — `@uptimizr/db` gains `defaultCellSizeForBounds(bounds, targetCells)`;
    the collector's world/gaze heatmaps derive a sensible voxel size from the selected scene's
    registered world bounds (ADR 0014) — or a `region` box — when `cellSize` is omitted, so big
    scenes no longer collapse into a few coarse blocks. An explicit `cellSize` still wins.
  - **Robust normalization** — `@uptimizr/react` exports `percentileMax(counts, p=0.95)`; the
    dashboard's 3D world heatmap normalizes color/size to the 95th-percentile cell so a couple of
    hotspots no longer wash out the rest of the scene.
  - **Totals + cold-spots** — new `buildWorldHeatmapStats`/`buildGazeHeatmapStats` builders, store
    methods, and `GET /api/v1/heatmaps/{world,gaze}/stats` routes returning `{ cellSize, cells, hits }`
    (the true occupied-cell + hit counts behind the truncated top-N voxels); the world panel surfaces
    coverage in its legend.
  - **Region (AABB) drill-down** — a `region=minX,minY,minZ,maxX,maxY,maxZ` filter (and matching
    `RegionOptions`/`regionClause` in `@uptimizr/db`, `region` in the `@uptimizr/react` client) scopes
    world/gaze/position heatmaps to an axis-aligned box for semantic zoom.

  Existing heatmap response shapes are unchanged; the stats endpoints and `region`/auto-`cellSize`
  behavior are all additive.

### Patch Changes

- Updated dependencies [b5c7eac]
  - @uptimizr/db@0.4.0
  - @uptimizr/db-clickhouse@0.2.3

## 0.3.0

### Minor Changes

- 9e22ebd: feat: caller-configured conversion-funnel aggregation (#78).

  Implements sub-issue (b) of the funnel epic in OSS. Authoring, persistence, and the
  saved-funnel dashboard panel remain hosted-only — the OSS dashboard stays a passive
  viewer (ADR 0038).

  - `@uptimizr/schema`: shared funnel contract — `funnelStepSchema`, `funnelStepsSchema`
    (2–20 steps), `funnelConfigSchema`, and `FUNNEL_CONFIG_VERSION`.
  - `@uptimizr/db`: new dialect-agnostic builder `buildFunnel` — a dynamic-N CTE chain
    using only `JOIN`/`min`/`GROUP BY` (no window or `ASOF` functions) so DuckDB and
    ClickHouse render identically (golden parity coverage on DuckDB). Semantics are
    sequential, first-touch, and monotonic.
  - `@uptimizr/collector-server`: new read endpoint `GET /api/v1/funnel`, wired through
    every store. The funnel definition is supplied per request as a `steps` JSON array
    (validated against `funnelStepsSchema`) and never stored.
  - `@uptimizr/react`: new client method `funnel(steps, params?)`.

- 394d5c8: feat: add render-scale truth, mesh interaction-kind, and aggregate desire-line analytics
  (#71, #72, #73).

  - `@uptimizr/db`: new dialect-agnostic builders `buildRenderScaleTruth`, `buildMeshInteractionKinds`,
    and `buildAggregateTrajectories` (with golden parity coverage on DuckDB).
  - `@uptimizr/collector-server`: new read endpoints `GET /api/v1/perf/render-scale`,
    `GET /api/v1/meshes/kinds`, and `GET /api/v1/paths`, wired through every store.
  - `@uptimizr/react`: new client methods `renderScale()` (derives `downscaled_share`), `meshKinds()`,
    and `aggregatePaths()`.
  - `@uptimizr/dashboard`: new built-in panels — Render-scale truth, Mesh interaction kinds, and
    Desire lines (ADR 0037, overview-only, gated to walkable sessions).

- e5ce02c: feat: add part-popularity, input-modality, dead-zone, and performance-distribution panels
  (#74, #75, #76, #77).

  - `@uptimizr/db`: new dialect-agnostic builders `buildTopMeshesBySource`, `buildTopMeshesTrend`,
    and `buildTopInputActions` (with golden parity coverage on DuckDB). `buildTopMeshesBySource` and
    `buildTopMeshesTrend` are scoped to **active** interactions (`mesh_interaction` + `pointer_click`),
    so passive gaze does not inflate part popularity — a deliberate divergence from `buildTopMeshes`.
    `input_action.action` is now threaded into the engine-neutral `name` column so it is queryable.
  - `@uptimizr/collector-server`: new read endpoints `GET /api/v1/meshes/sources`,
    `GET /api/v1/meshes/trend`, and `GET /api/v1/input-actions/top`, wired through every store.
  - `@uptimizr/react`: new client methods `topMeshesBySource()`, `topMeshesTrend()`, and
    `topInputActions()`.
  - `@uptimizr/dashboard`: four new built-in panels — Part-popularity leaderboard (#74, ranked meshes
    with a trend sparkline + per-mesh input-source split), Input-modality split (#75, per-source share
    - most-used shortcuts), Dead-zone report (#76, client-side intersection of scene coverage with the
      registered proxy, with an empty-state when no proxy is registered), and Performance distribution
      (#77, p05/p50/p95 FPS bands + per-session median-FPS histogram reusing the existing reads).

### Patch Changes

- Updated dependencies [9e22ebd]
- Updated dependencies [394d5c8]
- Updated dependencies [e5ce02c]
  - @uptimizr/schema@0.2.0
  - @uptimizr/db@0.3.0
  - @uptimizr/db-clickhouse@0.2.2

## 0.2.1

### Patch Changes

- a9308ea: fix(collector): allow credentials in the CORS preflight so cross-origin ingestion works. The SDK ingests via `navigator.sendBeacon`, which always sends in credentials mode `include`; without `Access-Control-Allow-Credentials: true` the browser dropped the beacon, breaking the common self-host layout where the app and collector run on different origins.
- df5b66b: chore: point each package's npm `homepage` at its specific docs page (instead of the GitHub tree URL) and add an `author` field across the public manifests.
- Updated dependencies [df5b66b]
  - @uptimizr/schema@0.1.1
  - @uptimizr/db@0.2.1
  - @uptimizr/db-clickhouse@0.2.1

## 0.2.0

### Minor Changes

- e78029b: feat: add a single-tenant ClickHouse store (`COLLECTOR_STORE=clickhouse`) for the scale tier. Events and metadata live in one ClickHouse database (no separate service), the schema is created on first boot, and the full analytics surface returns results identical to DuckDB (verified by a cross-engine parity suite). Adds the new `@uptimizr/db-clickhouse` package and the pure `clickhouseDialect` in `@uptimizr/db`. Implements ADR 0020.

### Patch Changes

- Updated dependencies [e78029b]
  - @uptimizr/db-clickhouse@0.2.0
  - @uptimizr/db@0.2.0

## 0.1.0

### Minor Changes

- b2b7b44: Initial public release of Uptimizr — open-source, privacy-first analytics for 3D scenes.

  This first `0.1.0` ships the full open-source data collector: the `@uptimizr/schema` event
  contracts, the `@uptimizr/sdk-core` runtime, engine connectors (`@uptimizr/babylon`,
  `@uptimizr/babylon-lite`, `@uptimizr/three`, `@uptimizr/r3f`, `@uptimizr/aframe`,
  `@uptimizr/playcanvas`, `@uptimizr/react`), session `@uptimizr/replay`, the `@uptimizr/heatmap`
  renderer, the embedded-store `@uptimizr/db` layer, the `@uptimizr/mcp` server, and the
  `@uptimizr/collector-server` ingestion/query API plus the `@uptimizr/dashboard`.

### Patch Changes

- Updated dependencies [b2b7b44]
  - @uptimizr/schema@0.1.0
  - @uptimizr/db@0.1.0

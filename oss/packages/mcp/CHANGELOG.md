# @uptimizr/mcp

## 1.2.0

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
- 785761d: Packaged agent docs: describe the labelled spatial clusters a `format=summary` result now carries
  (`region`, `regions`, `nearestMesh`, `distance`) and tell an agent to quote the label rather than
  the voxel coordinate.
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
- Updated dependencies [395aa36]
- Updated dependencies [969c899]
- Updated dependencies [395aa36]
  - @uptimizr/metrics@0.2.0
  - @uptimizr/agent-core@1.2.0
  - @uptimizr/schema@1.2.0

## 1.1.1

### Patch Changes

- 9ec59db: Packaged agent docs now cover the `format=full|table|summary` result envelope (and when to prefer
  each), and `@uptimizr/mcp`'s `AGENTS.md`/`llms.txt` additionally document the `uptimizr://scenes`
  resource, the three curated prompts, and the single key capability the server needs (`query`;
  `query:raw` is deliberately not required).
- Updated dependencies [9ec59db]
  - @uptimizr/agent-core@1.1.1

## 1.1.0

### Minor Changes

- afe3002: Generate the read-only tool catalog from the metric registry (ADR 0051 §1). `readTools` is no
  longer a hand-written array of 20 tools: `registryToTools()` derives one tool per `@uptimizr/db`
  metric that the collector serves on a read endpoint — **69** today — with the metric's
  interpretation notes and caveats in its description, an input schema built from the endpoint's
  filters and path parameters, and a new `ReadTool.outputSchema` (`{ rows: Row[] }`) derived from the
  metric's row schema. `@uptimizr/mcp` registers that as the MCP `outputSchema` and now returns
  `structuredContent` alongside the JSON text, so `tools/list` covers the whole read surface —
  dead/rage clicks, jank, per-device and per-scene FPS, coverage, blind spots, scene retention, the
  variant leaderboard and the load→bounce funnel included.

  The 20 tool names that shipped before the registry, and their argument schemas, are unchanged; a
  frozen-fixture test pins them, and the only widening is optional parameters the endpoints already
  accepted. `@uptimizr/agent-core` stays browser-safe: it reads the registry from the
  dependency-free `@uptimizr/metrics` package and never depends on `@uptimizr/db`, proven by a
  browser bundle test and a manifest test.

  New: `registryToTools()` and `filterReadTools(names)` in `@uptimizr/agent-core`, and a `tools`
  option on `@uptimizr/react`'s `useAssistant()` to pin which read tools an assistant may call
  (the per-backend default — the core subset locally, the full catalog hosted — is unchanged).

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

### Patch Changes

- fa489c1: Drop the `@uptimizr/db` dependency. Both packages read the metric registry, which now ships as the
  dependency-free `@uptimizr/metrics`; neither ever opened a database. `npm i @uptimizr/react` (which
  depends on `@uptimizr/agent-core`) and `npx @uptimizr/mcp` therefore no longer download
  `@duckdb/node-api`, a ~37 MB native binding they could not use. No behaviour, API or tool-catalog
  change — the same 69 tools with the same names, input schemas and output schemas.

  A new `dependencies.test.ts` in each package fails the build if `@uptimizr/db`, or any package with
  a native/optional binary dependency, becomes reachable from `dependencies` / `peerDependencies`
  again; `@uptimizr/agent-core`'s esbuild browser-bundle test continues to prove the same thing from
  the bundler's side.

- Updated dependencies [fa489c1]
- Updated dependencies [afe3002]
- Updated dependencies [fa489c1]
- Updated dependencies [018054b]
- Updated dependencies [2f1a753]
- Updated dependencies [ee1b7c7]
  - @uptimizr/agent-core@1.1.0
  - @uptimizr/metrics@0.1.0
  - @uptimizr/schema@1.1.0

## 1.0.1

### Patch Changes

- 3c3ee66: Make the package scripts cross-platform so a fresh Windows checkout can build. `clean` now uses `rimraf` instead of `rm -rf`, and the dashboard's `build`/`build:static`/`prepack`/`start` no longer rely on a POSIX `VAR=value` prefix. No runtime or published-output change.
- Updated dependencies [3c3ee66]
  - @uptimizr/agent-core@1.0.1
  - @uptimizr/schema@1.0.1

## 1.0.0

### Major Changes

- 9dd78e8: Uptimizr 1.0.0 — first stable release. Every package moves to 1.0.0 together; from here on the public API, the versioned event schema, and the collector's HTTP API follow semantic versioning (a breaking change is a major). Highlights since the public beta: six stable live-JS connectors (Babylon.js, Babylon Lite, three.js, react-three-fiber, PlayCanvas, A-Frame/WebXR) with per-engine capture parity and end-to-end coverage; WebXR in-scene hit resolution; three optional multi-writer stores (ClickHouse, PostgreSQL, SQL Server) behind the same `CollectorStore` contract with cross-engine parity tests; the in-browser analytics assistant with a local (WebLLM) or hosted model, tool-calling over the read-only analytics catalog, and streamed replies; and the MCP server for desktop AI clients. No wire-format or API changes are bundled with this bump — it marks the point where they become breaking.

### Patch Changes

- Updated dependencies [8194192]
- Updated dependencies [9dd78e8]
- Updated dependencies [6b6a2fe]
  - @uptimizr/agent-core@1.0.0
  - @uptimizr/schema@1.0.0

## 0.2.6

### Patch Changes

- 0af8209: Update runtime dependencies: Fastify 5.12.1 and @fastify/helmet 13.1.1 (collector-server), Next.js 16.3.3 and Babylon.js 9.23.0 (dashboard), and Zod 4.5.4 (schema, agent-core, mcp, replay, collector-server). Dev-only dependency bumps across the remaining packages are not released.
- Updated dependencies [0af8209]
  - @uptimizr/agent-core@0.3.1
  - @uptimizr/schema@0.6.1

## 0.2.5

### Patch Changes

- c84fec4: Resolve three security advisories in transitive runtime dependencies by tightening the
  workspace overrides: `brace-expansion` to `>=5.0.9` (GHSA-rgw5-rvv9-x895, denial of service
  via unbounded intermediate arrays — reached through `@fastify/static`), `fast-uri` to
  `>=3.1.5` (GHSA-7p8r-x3mc-p8w7, host confusion via a backslash authority introducer — reached
  through Fastify and the MCP SDK), and a new `hono` override at `>=4.12.34`
  (GHSA-8j4g-w8fx-2239, regular-expression denial of service in the CORS middleware — reached
  through the MCP SDK). No API or behavior changes.
- Updated dependencies [0e8b8a8]
- Updated dependencies [6d883d0]
- Updated dependencies [8041ca2]
  - @uptimizr/schema@0.6.0

## 0.2.4

### Patch Changes

- 1bb9846: Update the DuckDB and Model Context Protocol runtime dependencies to their latest compatible releases.

## 0.2.3

### Patch Changes

- Updated dependencies [dd34af8]
  - @uptimizr/agent-core@0.3.0

## 0.2.2

### Patch Changes

- Updated dependencies [d12c2f4]
- Updated dependencies [ae5bcd9]
- Updated dependencies [8ec1cdb]
  - @uptimizr/agent-core@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [b18c955]
  - @uptimizr/agent-core@0.2.1

## 0.2.0

### Minor Changes

- aaf0ea7: feat(mcp): add capability resources, curated prompts, and new read tools

  Evolve the read-only MCP server per ADR 0050 §7:

  - **Resources** for self-discovery: `uptimizr://capabilities` (a machine-readable descriptor of
    event types, the tool catalog, and parameter semantics, sourced from the shared catalog +
    `@uptimizr/schema`) and `uptimizr://scenes` (the live scene ids for the `scene` parameter).
  - **Prompts**: curated templates `weekly_scene_health`, `attention_hotspots`, and
    `xr_comfort_review` that drive the existing tools.
  - **New tools** surfaced from the shared catalog: funnels, aggregate desire-line paths,
    rendering-technology breakdown, and XR spatial analytics.

  The server remains strictly read-only (ADR 0003 / ADR 0017). A Streamable HTTP transport stays
  deferred as a separate, auth-gated follow-up.

### Patch Changes

- 3d04ee0: docs: clarify how to run the MCP server via `npx`, add a GitHub Copilot CLI config example, and
  document that the server connects only to the collector's HTTP query API (never the database
  directly), keeping the collector the single gateway to the store.
- f3ca500: refactor(mcp): source the read-only tool catalog and collector client from the new
  `@uptimizr/agent-core` package instead of defining them locally, so the tool surface is defined
  once and can't drift from the dashboard/demo assistants (ADR 0050). Public API and MCP runtime
  behavior are unchanged — the catalog and client are re-exported.
- 59fd29b: docs: refresh package and app READMEs to match current source

  Reconcile every package/app README with the actual code — corrected package/connector
  lists, public APIs and options, CLI flags, env vars, ports, the event catalog, and
  cross-links. Also drop "Google Analytics" references in favor of neutral "web analytics"
  wording. Documentation-only; no runtime behavior changes.

- Updated dependencies [dd6e3f8]
- Updated dependencies [36f78e8]
- Updated dependencies [f3ca500]
- Updated dependencies [aaf0ea7]
- Updated dependencies [59fd29b]
  - @uptimizr/agent-core@0.2.0
  - @uptimizr/schema@0.5.1

## 0.1.1

### Patch Changes

- df5b66b: chore: point each package's npm `homepage` at its specific docs page (instead of the GitHub tree URL) and add an `author` field across the public manifests.

## 0.1.0

### Minor Changes

- b2b7b44: Initial public release of Uptimizr — open-source, privacy-first analytics for 3D scenes.

  This first `0.1.0` ships the full open-source data collector: the `@uptimizr/schema` event
  contracts, the `@uptimizr/sdk-core` runtime, engine connectors (`@uptimizr/babylon`,
  `@uptimizr/babylon-lite`, `@uptimizr/three`, `@uptimizr/r3f`, `@uptimizr/aframe`,
  `@uptimizr/playcanvas`, `@uptimizr/react`), session `@uptimizr/replay`, the `@uptimizr/heatmap`
  renderer, the embedded-store `@uptimizr/db` layer, the `@uptimizr/mcp` server, and the
  `@uptimizr/collector-server` ingestion/query API plus the `@uptimizr/dashboard`.

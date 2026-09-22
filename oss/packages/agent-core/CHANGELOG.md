# @uptimizr/agent-core

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
- Updated dependencies [395aa36]
- Updated dependencies [f5fc7b6]
- Updated dependencies [375cb7c]
- Updated dependencies [395aa36]
- Updated dependencies [0c7507d]
- Updated dependencies [395aa36]
- Updated dependencies [395aa36]
- Updated dependencies [e1213c8]
- Updated dependencies [395aa36]
- Updated dependencies [395aa36]
- Updated dependencies [395aa36]
- Updated dependencies [395aa36]
- Updated dependencies [969c899]
- Updated dependencies [395aa36]
  - @uptimizr/metrics@0.2.0
  - @uptimizr/schema@1.2.0

## 1.1.1

### Patch Changes

- 9ec59db: Packaged agent docs now cover the `format=full|table|summary` result envelope (and when to prefer
  each), and `@uptimizr/mcp`'s `AGENTS.md`/`llms.txt` additionally document the `uptimizr://scenes`
  resource, the three curated prompts, and the single key capability the server needs (`query`;
  `query:raw` is deliberately not required).

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

- Updated dependencies [fa489c1]
- Updated dependencies [ee1b7c7]
  - @uptimizr/metrics@0.1.0

## 1.0.1

### Patch Changes

- 3c3ee66: Make the package scripts cross-platform so a fresh Windows checkout can build. `clean` now uses `rimraf` instead of `rm -rf`, and the dashboard's `build`/`build:static`/`prepack`/`start` no longer rely on a POSIX `VAR=value` prefix. No runtime or published-output change.

## 1.0.0

### Major Changes

- 9dd78e8: Uptimizr 1.0.0 — first stable release. Every package moves to 1.0.0 together; from here on the public API, the versioned event schema, and the collector's HTTP API follow semantic versioning (a breaking change is a major). Highlights since the public beta: six stable live-JS connectors (Babylon.js, Babylon Lite, three.js, react-three-fiber, PlayCanvas, A-Frame/WebXR) with per-engine capture parity and end-to-end coverage; WebXR in-scene hit resolution; three optional multi-writer stores (ClickHouse, PostgreSQL, SQL Server) behind the same `CollectorStore` contract with cross-engine parity tests; the in-browser analytics assistant with a local (WebLLM) or hosted model, tool-calling over the read-only analytics catalog, and streamed replies; and the MCP server for desktop AI clients. No wire-format or API changes are bundled with this bump — it marks the point where they become breaking.

### Minor Changes

- 8194192: Token streaming across the provider seam. `ProviderRequest` gains an optional `onToken(delta)` listener — additive, so `LlmProvider.complete()` still returns `Promise<ProviderResponse>` and every existing provider keeps working unchanged. The hosted adapter now requests a streamed reply whenever a listener is present and parses both the OpenAI-compatible and Anthropic Server-Sent Events formats (partial chunks across reads, `[DONE]`, tool-call deltas) using string membership and linear scans only — no regex over model output — while still returning the complete assembled response; a gateway that ignores `stream` falls back to the JSON body. The WebLLM adapter streams the tools-less answer turn straight from the GPU (tool-calling turns stay non-streaming because WebLLM's Hermes grammar emits a JSON tool-call array there) and honours the abort signal mid-stream. `runAgent` gains `onStream`, re-emitting per-turn `delta` / `turn_end` events (`AgentStreamEvent`) so a UI can render the answer as it is generated and tell an answer turn apart from a tool-call turn; the tool-calling loop is unchanged.
- 6b6a2fe: WebLLM adapter: reclaim previous local-model weights when switching models. Loading a model now evicts the other curated models' cached weights from the browser's Cache Storage first (via WebLLM's `hasModelInCache` / `deleteModelAllInfoInCache`), so switching among the ~4 GB Hermes models no longer stacks caches until the origin's storage quota is exceeded. New `cachePolicy` option on `createWebLlmProvider` (`"active-only"`, the default, or `"keep-all"` to opt out), an `onCacheEvicted(ids)` callback, a `provider.clearCachedModels()` method, and a standalone `clearCachedModels()` helper that deletes every cached curated model and returns the ids reclaimed. Eviction is scoped to the known curated model ids only.

## 0.3.1

### Patch Changes

- 0af8209: Update runtime dependencies: Fastify 5.12.1 and @fastify/helmet 13.1.1 (collector-server), Next.js 16.3.3 and Babylon.js 9.23.0 (dashboard), and Zod 4.5.4 (schema, agent-core, mcp, replay, collector-server). Dev-only dependency bumps across the remaining packages are not released.

## 0.3.0

### Minor Changes

- dd34af8: Make the local (WebLLM) analytics assistant genuinely useful, not just
  non-crashing, within the in-browser 7–8B Hermes ceiling (ADR 0050).

  - **Current-time grounding.** The assistant now stamps the current time (ISO 8601
    - epoch ms) into the system prompt at send time via a new
      `composeSystemPrompt(base, nowMs)` helper and an injectable `useAssistant({ now })`
      clock (default `Date.now`). Small local models can finally resolve relative
      ranges ("today", "this week", "last 24h") into concrete `since`/`until` args —
      the fix for simple time-scoped questions returning no answer.
  - **Focused core tool set for local.** `@uptimizr/agent-core` adds
    `coreReadTools`, `CORE_READ_TOOL_NAMES`, and `selectReadTools(kind)` — a
    filtered VIEW of the existing `readTools` (schema still lives once). The React
    hook sends the ~7-tool core subset to the **local** backend and the full 20 to
    **hosted** backends, so a 4-bit local model isn't overwhelmed.
  - **Strongest curated default.** `CURATED_MODELS` is reordered strongest-first so
    the default is Hermes 3 (Llama 3.1 8B); all three stay selectable.
  - **Guided example prompts** in `<AssistantPanel>` (single-core-tool starter
    questions) and an honest local-vs-hosted capability note.

## 0.2.2

### Patch Changes

- d12c2f4: Force a final, tools-disabled synthesis turn so the assistant always replies.
  Small local WebLLM (Hermes 7–8B) models often returned an empty `final` answer —
  or kept tool-calling until the step cap — so the loop ended with no reply. When a
  run would otherwise end without a usable answer (an empty final, or `maxSteps`
  reached while still tool-calling), `runAgent` now makes one extra
  `provider.complete()` with tools disabled, forcing the model to compose a
  plain-text answer from the tool results it already gathered (at most one such
  forced turn per run; on/off via `forceFinalAnswer`, default `true`). The hosted
  (OpenAI/Anthropic) and WebLLM adapters now omit `tools`/`tool_choice` entirely
  when no tools are offered so the model answers in prose. Oversized tool results
  are also truncated (plain slice + marker, tunable via `maxToolResultChars`,
  default 8000) to protect small models' context. Still local-only for the local
  backend — no new data egress.
- ae5bcd9: Raise the WebLLM local model's context window to 8192 tokens so the analytics
  assistant's prompt fits. The curated Hermes model records default to a
  4096-token window, which rejected the assistant's system prompt + tool schemas +
  results ("Prompt tokens exceed context window size"). The WebLLM adapter now
  passes `chatOpts.context_window_size` when creating the engine (tunable via
  `createWebLlmProvider({ contextWindowSize })`).
- 8ec1cdb: Explain local-model browser-storage limits instead of a raw "quota exceeded".

  The local WebLLM backend caches each curated model's ~4 GB of weights in the
  browser's Cache Storage; loading or switching among several models accumulates
  multiple copies until the per-origin quota is exceeded, at which point the Cache
  API throws a `QuotaExceededError` DOMException. Previously the assistant rendered
  that bare "Quota exceeded." string, which reads like an LLM API quota even though
  the local backend has zero network egress.

  `@uptimizr/agent-core` now classifies that DOMException (by `instanceof`/`.name`,
  never a regex) and rethrows it as a typed `WebLlmStorageError` with an actionable
  message, from both engine init and generation, while leaving all other errors
  untouched. A best-effort `navigator.storage.estimate()` preflight fails fast
  before a multi-GB download when free space is clearly insufficient (guarded and
  soft — skipped when the API is unavailable or reports ample space). Each
  `CuratedModel` gains a numeric `downloadBytes` field for that comparison, and
  `WebLlmStorageError` / `isQuotaExceededError` are exported.

  `@uptimizr/react`'s `<AssistantPanel>` now renders distinct, accessible guidance
  (free disk space, clear this site's cached data, try the smallest model or a
  hosted backend) for a `WebLlmStorageError`, keeping the generic rendering for all
  other errors.

## 0.2.1

### Patch Changes

- b18c955: Fix the local (WebLLM) assistant backend throwing `CustomSystemPromptError`
  ("When using Hermes-2-Pro function calling via ChatCompletionRequest.tools,
  cannot specify customized system prompt.") when asking a question. WebLLM's
  Hermes function-calling path injects its own system prompt and rejects a
  caller-supplied `system` message while tools are present, so the WebLLM adapter
  now folds the assistant's system instructions into the first user turn when
  tools are sent. Hosted backends (OpenAI/Anthropic) are unchanged.

## 0.2.0

### Minor Changes

- dd6e3f8: feat(agent-core): add the two user-controlled LLM provider adapters (ADR 0050 §4), exported from
  code-split subpaths so the core stays lightweight and browser-safe.

  - `@uptimizr/agent-core/providers/webllm` — local, in-browser inference on WebGPU. The
    `@mlc-ai/web-llm` runtime is an optional dependency loaded via a lazy `import()` only on first
    use; a curated model list with size disclosures; an explicit download-consent gate; WebGPU
    feature detection; weights cached by the runtime in Cache Storage (never precached). Zero data
    egress.
  - `@uptimizr/agent-core/providers/hosted` — bring-your-own OpenAI-compatible or Anthropic endpoint
    - key, stored in the browser only; the browser calls the provider directly (only the prompt and
      aggregated results leave, to the user's own provider). Documents the required provider CORS.
  - `@uptimizr/agent-core/providers` — barrel that also exports backend-selection persistence
    (`localStorage`), WebGPU detection, and the privacy-preserving default (local when WebGPU is
    present).

- f3ca500: feat(agent-core): new framework-agnostic, browser-safe package that owns the agent tool surface
  once (ADR 0050 §1).

  It provides the read-only tool catalog (`readTools`, one entry per documented aggregate collector
  query endpoint), the `GET`-only collector client, a headless LLM provider-adapter interface
  (`LlmProvider`), and the headless tool-calling loop (`runAgent`) that drives LLM ↔ tools ↔
  collector. Strictly read-only — no ingestion, mutation, or raw per-session event tools (ADR 0003 /
  ADR 0017). Consumed by `@uptimizr/mcp` and, in future, the dashboard and demo assistants.

- aaf0ea7: feat(agent-core): add read tools for funnels, desire-line paths, rendering technology, and XR analytics

  Extend the shared read-only tool catalog with one entry per existing aggregate query endpoint:
  `funnel` (ADR 0038), `aggregate_paths` (ADR 0037), `rendering_technology` (ADR 0046), and the XR
  comfort/usage tools `xr_rotation` / `xr_sources` / `xr_abandonment` / `xr_locomotion` (ADR 0048).
  The surface stays strictly aggregate and read-only (ADR 0003 / ADR 0017).

### Patch Changes

- 36f78e8: fix(agent-core): curate the local WebLLM models to the tool-calling-capable set and add a preflight
  guard (ADR 0050 §4).

  The curated list previously included models WebLLM **rejects** for `ChatCompletionRequest.tools`
  (e.g. the default `Llama-3.2-1B-Instruct-q4f16_1-MLC`), so users could download gigabytes of weights
  only to hit a runtime "not supported for tools" error on their first question. WebLLM hard-codes
  function calling to the 7–8B Hermes-2-Pro / Hermes-3 family, and the assistant relies on
  tool-calling.

  - `CURATED_MODELS` now lists only tool-calling-capable Hermes q4f16_1 variants, smallest-first — the
    new default is `Hermes-2-Pro-Mistral-7B-q4f16_1-MLC`. VRAM/size disclosures are sourced from
    WebLLM's `prebuiltAppConfig`.
  - New `SUPPORTED_TOOL_CALLING_MODELS` allowlist and `UnsupportedToolCallingModelError`, exported from
    `providers` and `providers/webllm`. `createWebLlmProvider` validates the resolved model **before**
    any download/engine init and throws if it isn't tool-calling-capable — no more wasted downloads.

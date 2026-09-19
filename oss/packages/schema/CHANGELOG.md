# @uptimizr/schema

## 1.2.0

### Minor Changes

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

- 395aa36: Conditional subscriptions, an SSE stream and signed webhooks (ADR 0051 §6). A subscription names a
  registry metric, a window and a predicate — `threshold`, `anomaly`, `movers`, `new_value` or
  `presence` — and the collector evaluates it in-process on a bounded scheduler, records each firing
  in a per-subscription log and delivers it over SSE and/or an HMAC-signed webhook. Webhook egress is
  disabled until `COLLECTOR_WEBHOOK_ALLOWED_HOSTS` names the hosts the collector may reach, and a
  webhook secret is write-only. Adds `/api/v1/subscriptions*`, a read-only dashboard panel, a
  `list_subscriptions` agent tool and `uptimizr subscriptions list|add|remove|test`.

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

## 1.1.0

### Minor Changes

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

## 1.0.1

### Patch Changes

- 3c3ee66: Make the package scripts cross-platform so a fresh Windows checkout can build. `clean` now uses `rimraf` instead of `rm -rf`, and the dashboard's `build`/`build:static`/`prepack`/`start` no longer rely on a POSIX `VAR=value` prefix. No runtime or published-output change.

## 1.0.0

### Major Changes

- 9dd78e8: Uptimizr 1.0.0 — first stable release. Every package moves to 1.0.0 together; from here on the public API, the versioned event schema, and the collector's HTTP API follow semantic versioning (a breaking change is a major). Highlights since the public beta: six stable live-JS connectors (Babylon.js, Babylon Lite, three.js, react-three-fiber, PlayCanvas, A-Frame/WebXR) with per-engine capture parity and end-to-end coverage; WebXR in-scene hit resolution; three optional multi-writer stores (ClickHouse, PostgreSQL, SQL Server) behind the same `CollectorStore` contract with cross-engine parity tests; the in-browser analytics assistant with a local (WebLLM) or hosted model, tool-calling over the read-only analytics catalog, and streamed replies; and the MCP server for desktop AI clients. No wire-format or API changes are bundled with this bump — it marks the point where they become breaking.

## 0.6.1

### Patch Changes

- 0af8209: Update runtime dependencies: Fastify 5.12.1 and @fastify/helmet 13.1.1 (collector-server), Next.js 16.3.3 and Babylon.js 9.23.0 (dashboard), and Zod 4.5.4 (schema, agent-core, mcp, replay, collector-server). Dev-only dependency bumps across the remaining packages are not released.

## 0.6.0

### Minor Changes

- 0e8b8a8: Add the `ar_placement` event and AR placement funnel analytics (#156, ADR 0048).

  - **schema:** new source-neutral `ar_placement` event, emitted once per placement
    "settle" for retail "view in your room" AR — `mesh`, final world `position`, coarse
    `surface` (`floor`/`wall`/`table`/`ceiling`/`unknown`), `attempts`, `timeToPlaceMs`,
    `scale`, and `final`. Reuses the promoted `mesh`/`position` columns, so no DB
    migration.
  - **@uptimizr/babylon:** `babylonArPlacementCollector` captures WebXR hit-test/anchor
    placement and enqueues one `ar_placement` per settle, classifying the surface coarsely
    from the hit normal (`classifyArSurface`). Coarse, on-device-only signals (ADR 0003).
  - **@uptimizr/db:** dialect-agnostic `buildArPlacementTimeToPlace`,
    `buildArPlacementAttempts`, and `buildArPlacementSurfaces` builders for the placement
    funnel (time-to-place distribution, re-placement count, surface breakdown), with parity
    cases.
  - **@uptimizr/react:** `arPlacementTimeToPlace` / `arPlacementAttempts` /
    `arPlacementSurfaces` API methods and an **AR placement funnel** dashboard panel.

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

- 8041ca2: Add an XR **tracking-quality timeline** (#155, ADR 0048) by extending the existing
  `capability_change` event with a new `"tracking"` kind — events live once, no new
  event type, no DB migration.

  - **schema.** `capabilityChangeKindSchema` gains `"tracking"`, and
    `capabilityChangeSchema` now spreads `inputSourceShape` (`source` / `handedness`)
    and an optional `durationMs` (the completed degraded-episode length). A tracking
    transition reuses the event's existing `from` / `to` / `reason` shape (e.g.
    `"hand"` → `"lost"`, `"6dof"` → `"3dof"`).
  - **sdk-core.** `reportCapabilityChange(...)` threads `source` / `handedness` /
    `durationMs` through, and the XR capture options gain a `tracking` toggle.
  - **@uptimizr/babylon.** The XR collector reports coarse, best-effort tracking
    loss/recovery — when a hand or controller drops out of the input registry
    mid-session it emits one `capability_change { kind: "tracking" }` per completed
    degraded episode (via the same `reportCapabilityChange` path as `device-recovery`).
  - **@uptimizr/db.** New dialect-agnostic `buildTrackingQuality(projectId, opts, d)`
    aggregation (per session: `degraded_ms`, `hand_degraded_ms`,
    `controller_degraded_ms`, `degraded_episodes`, span) plus a `PARITY_CASES` entry so
    DuckDB and ClickHouse stay provably equal. The degraded duration reuses the shared
    `visible_ms` column.
  - **@uptimizr/react.** New `trackingQuality()` API method (`GET /api/v1/xr/tracking`)
    and a **Tracking quality** catalog panel (share of session time degraded, split by
    hand vs. controller) surfaced on the overview alongside scene health.

## 0.5.1

### Patch Changes

- 59fd29b: docs: refresh package and app READMEs to match current source

  Reconcile every package/app README with the actual code — corrected package/connector
  lists, public APIs and options, CLI flags, env vars, ports, the event catalog, and
  cross-links. Also drop "Google Analytics" references in favor of neutral "web analytics"
  wording. Documentation-only; no runtime behavior changes.

## 0.5.0

### Minor Changes

- e39cbc7: feat: optional `position` on `runtime_error` / `graphics_diagnostic` + spatial error heatmap (#154)

  Add an optional, best-effort `position` (`[x, y, z]`, the camera pose at the moment the event
  fired) to the `runtime_error` and `graphics_diagnostic` events. The Babylon connector stamps it
  automatically from the tracked camera; `sdk-core` gains a `setPositionProvider` seam so any connector
  can supply one, and enrichment happens centrally in `emitInternal` (before `beforeSend`, so it stays
  redactable). The field is additive and backward-compatible — older events simply omit it, and it
  reuses the already-promoted `position` column (no migration).

  On the read side, `@uptimizr/db` adds `buildErrorHeatmap` (voxel-bins positioned errors +
  diagnostics, with optional `severity`/`category`/`errorKind` filters), surfaced via the collector's
  new `GET /api/v1/heatmaps/errors` endpoint and a new **Error heatmap (3D)** dashboard panel
  (`@uptimizr/react`) reusing the world-heatmap view — revealing _where_ in the scene things break,
  not just _when_.

- 3c0a20b: feat(perf): add optional `position` to `frame_perf` + spatial FPS heatmap (#145)

  `frame_perf` samples can now carry the camera world-`position` at the moment
  they're taken, so the collector can show _where_ FPS drops, not just _when_. The
  Babylon connector fills it automatically from the tracked camera; other
  connectors may set it on the emitted event.

  - **schema**: `frame_perf.position` is an optional `vec3` (additive,
    backward-compatible — events still validate without it).
  - **sdk-core / babylon**: the perf snapshot threads an optional `position`
    through the aggregator into the emitted event; Babylon reads the tracked camera.
  - **db**: new dialect-agnostic `buildPerfHeatmap` voxel builder
    (`samples`/`avg_fps`/`min_fps`, ordered `avg_fps ASC`). Reuses the promoted
    `position` column — **no migration**.
  - **react**: new `perfHeatmap()` client method + **Performance heatmap (3D)**
    panel (reuses the world-heatmap renderer; hot = slow, honest per-voxel FPS on
    hover).

  The collector exposes it at `GET /api/v1/heatmaps/perf`.

- 3193a21: feat: add optional `uv` field for a per-mesh texture-space heatmap (#149)

  `pointer_click`, `mesh_interaction`, and `hover_dwell` now carry an optional,
  unclamped `uv: [u, v]` texture coordinate, captured by the Babylon connector from
  the raycast hit (`PickingInfo.getTextureCoordinates()`). It rides in the event
  `payload` — additive and backward-compatible, no column promotion or migration.

  A new `buildMeshUvHeatmap` query builder and `GET /api/v1/heatmaps/mesh-uv`
  endpoint bin a single mesh's `uv` values into a grid, surfaced by the dashboard's
  new **Mesh UV heatmap** panel (interactive mesh picker, defaults to the
  most-interacted mesh).

## 0.4.0

### Minor Changes

- 08c4abd: Add the `graphics_diagnostic` event contract and the `captureGraphicsDiagnostics`
  opt-in flag (ADR 0021 part 2, foundation). The new event is a single
  engine-agnostic GPU-health signal with `severity`, `category`, optional `backend`
  (reusing the `graphics.api` enum), length-capped `message`/`code`, and a `count`
  field that discriminates a discrete incident marker from an aggregated per-session
  rollup. Capture is gated by the new `captureGraphicsDiagnostics` flag in
  `@uptimizr/sdk-core`, **off by default** (mirroring `captureErrors`);
  `context_lost`/`context_restored` stay always-on and exempt. No connector capture
  wiring yet — that lands in the per-signal slices.

## 0.3.0

### Minor Changes

- fa6c472: Add a browser/OS performance segment derived from the request User-Agent at
  ingestion (#11). The collector reduces the User-Agent to a coarse, non-PII
  `{ browser, os }` pair (raw UA never stored) and merges it into
  `session_start.device`; `buildPerfByDevice` and the dashboard "FPS by device"
  panel now segment per-session median FPS by browser/OS in addition to graphics
  backend, mobile flag, and GPU renderer. No SDK, schema-capture, or storage
  migration change (ADR 0041).
- 32248e0: feat: reconstruct near-plane origin for flat-pointer click rays (ADR 0043)

  Flat pointers (mouse/touch/stylus) have no native pointing ray, so the click-ray heatmap
  (`/api/v1/heatmaps/click-rays`) collapsed every flat click to the nearest `camera_sample`
  position. Capture the camera's projection intrinsics and unproject each click's `screen` onto the
  camera near plane so flat-pointer rays fan out the way the clicks were actually made.

  - **`@uptimizr/schema`** — `camera_sample` gains optional `aspect` and `near` (alongside the
    existing `fov`).
  - **`@uptimizr/babylon`** — captures `engine.getAspectRatio(camera)` and `camera.minZ`, emitted
    only when finite and positive.
  - **`@uptimizr/db` / `@uptimizr/db-clickhouse`** — `fov`/`aspect`/`near` promoted to dedicated
    columns (forward-only migrations); `buildClickGazeRay` unprojects flat clicks onto the near
    plane using a canonical world-up / no-roll basis.

  Pose sources (XR/hand/gaze) keep their native ray origin (ADR 0011); missing intrinsics (legacy
  data) or a degenerate look-straight-up/down view fall back to the camera position, so existing
  behaviour and parity goldens are unchanged. Additive and non-breaking.

## 0.2.0

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

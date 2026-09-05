# @uptimizr/db

## 1.0.0

### Major Changes

- 9dd78e8: Uptimizr 1.0.0 — first stable release. Every package moves to 1.0.0 together; from here on the public API, the versioned event schema, and the collector's HTTP API follow semantic versioning (a breaking change is a major). Highlights since the public beta: six stable live-JS connectors (Babylon.js, Babylon Lite, three.js, react-three-fiber, PlayCanvas, A-Frame/WebXR) with per-engine capture parity and end-to-end coverage; WebXR in-scene hit resolution; three optional multi-writer stores (ClickHouse, PostgreSQL, SQL Server) behind the same `CollectorStore` contract with cross-engine parity tests; the in-browser analytics assistant with a local (WebLLM) or hosted model, tool-calling over the read-only analytics catalog, and streamed replies; and the MCP server for desktop AI clients. No wire-format or API changes are bundled with this bump — it marks the point where they become breaking.

### Minor Changes

- fceff6c: Add `postgresDialect` (+ `PostgresSettings` via `readDbSettings().postgres`, read from
  `POSTGRES_URL` / `DATABASE_URL`, `POSTGRES_SCHEMA`, `POSTGRES_POOL_MAX`) and the engine-neutral
  relational helpers (`renderNearestRowJoin`, `renderNativeAsofJoin`, `toPositionalParams`) that
  row-store dialects share (#84; the SQL Server port reuses them).

  `Dialect` gains `arrayLength(expr)` and a structured `asofJoin(spec)`, which **replaces** the
  `asofInnerJoin` / `asofLeftJoin` string introducers so engines without a native `ASOF JOIN` can
  emulate it. The shared aggregations now emit portable `count(*)` / `arrayLength` — DuckDB and
  ClickHouse output is unchanged (parity suites pass as before).

### Patch Changes

- 29c167d: Add `mssqlDialect` for the SQL Server store (#85) plus `MssqlSettings` via `readDbSettings().mssql`
  (`MSSQL_URL`, or `MSSQL_SERVER` / `MSSQL_PORT` / `MSSQL_DATABASE` / `MSSQL_USER` / `MSSQL_PASSWORD`,
  `MSSQL_ENCRYPT`, `MSSQL_TRUST_SERVER_CERTIFICATE`, `MSSQL_POOL_MAX`), and `toTsql` — the
  execution-time adaptation of the shared SQL for the constructs T-SQL cannot parse (inline vector
  indexing over JSON arrays, `LIMIT`, `GROUP BY <alias>`, `atan2`). The three boolean-valued flag
  columns in the shared aggregations became portable 0/1 flags; DuckDB, ClickHouse and Postgres
  output is unchanged (parity suites pass as before). No `Dialect` interface change.
- Updated dependencies [9dd78e8]
  - @uptimizr/schema@1.0.0

## 0.8.2

### Patch Changes

- Updated dependencies [0af8209]
  - @uptimizr/schema@0.6.1

## 0.8.1

### Patch Changes

- db76d60: Update runtime dependencies: Fastify 5.12 / @fastify/static 10.1.3 (collector-server), Next.js 16.3.1, Babylon.js 9.21.2 and WebLLM 0.2.84 (dashboard), and DuckDB node-api 1.5.5-r.4 (db). Dev-only dependency bumps across the remaining packages are not released.

## 0.8.0

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

### Patch Changes

- fa842eb: Update runtime dependencies to their latest releases: Fastify and its rate-limit
  plugin (collector-server), Babylon.js core and loaders (dashboard), and the DuckDB
  Node API (db). Development-only tooling across the workspace was refreshed to latest
  as well; TypeScript is intentionally held back pending the 7.x migration.
- Updated dependencies [0e8b8a8]
- Updated dependencies [6d883d0]
- Updated dependencies [8041ca2]
  - @uptimizr/schema@0.6.0

## 0.7.3

### Patch Changes

- 1bb9846: Update the DuckDB and Model Context Protocol runtime dependencies to their latest compatible releases.

## 0.7.2

### Patch Changes

- 59fd29b: docs: refresh package and app READMEs to match current source

  Reconcile every package/app README with the actual code — corrected package/connector
  lists, public APIs and options, CLI flags, env vars, ports, the event catalog, and
  cross-links. Also drop "Google Analytics" references in favor of neutral "web analytics"
  wording. Documentation-only; no runtime behavior changes.

- Updated dependencies [59fd29b]
  - @uptimizr/schema@0.5.1

## 0.7.1

### Patch Changes

- a7aad24: fix(db): make `buildSceneRetention` and `buildVariantLeaderboard` run on stock ClickHouse

  Both builders previously emitted an `INNER JOIN … ON` whose condition mixed a
  left and a right column in an inequality (matching a row to the session's next
  event). DuckDB accepts that, but ClickHouse rejects it unless the session sets
  `allow_experimental_join_condition = 1`.

  The scene-retention builder now uses an `ASOF INNER JOIN` (equality + one
  inequality — natively supported by ClickHouse) to find each marker's nearest
  following scene, and the variant-leaderboard builder keeps every join keyed on
  `session_id` alone, moving the ordered / relative guards into `WHERE`. Output
  row shapes and results are unchanged on both engines.

  Downstream consumers that scoped `allow_experimental_join_condition` around
  these two reads (e.g. a hosted `panelQuerySettings` shim) can drop that
  workaround after upgrading — the generated SQL runs on managed/stock ClickHouse
  with default settings.

## 0.7.0

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

- db331a3: feat: load → bounce/abandon funnel (#152). Adds a `buildLoadBounceFunnel` query
  builder that buckets sessions by their initial `asset_load` time band and counts
  how many bounced (no `pointer_*` / `mesh_interaction` / `camera_gesture` after
  load), a `GET /api/v1/load-bounce` collector endpoint, an `api.loadBounce()` client
  method, and a "Load → bounce funnel" dashboard panel. Derived from existing events —
  no schema change.
- de0836d: feat: blind-spot / never-noticed mesh report (#143)

  Add a "blind spots" leaderboard — the inverse of the most-interacted / part-
  popularity panels — surfacing meshes that render but are never noticed. A new
  `@uptimizr/db` aggregation (`buildMeshBlindSpots`) cross-references
  `mesh_visibility` on-screen time against `mesh_interaction` + `hover_dwell`
  engagement per mesh, keeping only meshes that were actually visible and ranking
  the most-seen-yet-least-touched first. Exposed through the collector's
  `GET /api/v1/meshes/blind-spots` endpoint and a new **Blind spots** panel in
  `@uptimizr/react`'s `ossPanelCatalog` (`meshBlindSpots` API client +
  `BlindSpotReportView`). No schema change — reuses the existing event types.

- 3193a21: feat: add optional `uv` field for a per-mesh texture-space heatmap (#149)

  `pointer_click`, `mesh_interaction`, and `hover_dwell` now carry an optional,
  unclamped `uv: [u, v]` texture coordinate, captured by the Babylon connector from
  the raycast hit (`PickingInfo.getTextureCoordinates()`). It rides in the event
  `payload` — additive and backward-compatible, no column promotion or migration.

  A new `buildMeshUvHeatmap` query builder and `GET /api/v1/heatmaps/mesh-uv`
  endpoint bin a single mesh's `uv` values into a grid, surfaced by the dashboard's
  new **Mesh UV heatmap** panel (interactive mesh picker, defaults to the
  most-interacted mesh).

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

- 53a4695: feat: add a canned scene/level retention funnel (#147)

  A zero-config Sankey preset built directly from `scene_change` markers — session
  counts flowing scene → scene in observed order, weighted by distinct sessions, so
  level-to-level drop-off is visible without authoring any funnel steps (the
  complement to the caller-authored funnel, ADR 0038).

  - `@uptimizr/db`: new `buildSceneRetention()` query builder (parity-safe — no
    window functions) plus `SceneRetentionOptions` / `SceneRetentionRow` types.
  - `@uptimizr/react`: new `CollectorApi.sceneRetention()` + `SceneRetentionLink`
    type, and a built-in **Scene retention funnel** panel in the OSS catalog.

  Served by the collector at `GET /api/v1/scene-retention`.

- b0ac76e: feat(db,react): variant → conversion leaderboard for product configurators (#150)

  Add a read-only leaderboard that ranks `custom` variant events (grouped by their
  `name`) by views, with distinct sessions, mean dwell before the next variant
  switch/conversion, and an optional per-variant conversion rate to a caller-supplied
  success event. Reuses the ADR 0038 funnel-step predicate shape — no schema change.

  - `@uptimizr/db`: `buildVariantLeaderboard` query builder (`VariantLeaderboardOptions`
    / `VariantLeaderboardRow`), engine-agnostic so DuckDB and ClickHouse match.
  - `@uptimizr/react`: `CollectorApi.variantLeaderboard()` client method and a new
    `variant-leaderboard` dashboard panel with an in-panel success-event picker.

  Also wires the `GET /api/v1/variant-leaderboard` endpoint through the collector
  server (store contract + DuckDB / ClickHouse / memory stores).

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

- 872d4b2: feat(dashboard): VR comfort & locomotion panel (#148)

  Add an XR-focused locomotion + comfort panel that reuses existing schema (no
  schema change). A new `@uptimizr/db` `buildXrLocomotionComfort` builder returns,
  per XR session, its fly/navigate gesture counts, `mesh_interaction` teleport
  count, total locomotion duration, and wall-clock span. The `@uptimizr/react`
  catalog gains an `xrLocomotionComfortPanel` that renders the locomotion-style mix
  (teleport vs. smooth locomotion vs. navigate) and a heavy-vs-light-locomotion
  early-exit correlation — a motion-discomfort proxy. Exposed via
  `GET /api/v1/xr/locomotion`.

### Patch Changes

- Updated dependencies [e39cbc7]
- Updated dependencies [3c0a20b]
- Updated dependencies [3193a21]
  - @uptimizr/schema@0.5.0

## 0.6.0

### Minor Changes

- a580f5e: Surface opt-in engine diagnostics in the dashboard (#16, ADR 0021 part 2). Adds a
  dialect-agnostic `buildGraphicsDiagnosticCounts(projectId, opts, dialect)` aggregation to
  `@uptimizr/db` that rolls `graphics_diagnostic` events up into `(severity, category, backend)`
  incident counts, folding discrete markers (no `count`) and per-session rollups (`count: N`)
  honestly as `SUM(COALESCE(count, 1))`. The fields ride in stored JSON (nothing promoted to a
  column), so extraction goes through the existing `jsonText` helper plus a new nullable
  `Dialect.jsonInt(column, ...path)` so the `count` cast stays identical across DuckDB and
  ClickHouse (covered by a `PARITY_CASES` entry).

  `@uptimizr/react` gains a `graphicsDiagnosticCounts()` query-client method (and
  `GraphicsDiagnosticCount` type) hitting the new `GET /api/v1/graphics-diagnostics` collector
  endpoint. Capture is off by default, so the new dashboard "Engine diagnostics" panel shows an
  explicit opt-in empty state until `captureGraphicsDiagnostics` is enabled.

- c8887f7: Surface the always-on rendering-technology mix in the dashboard (#120, ADR 0021 part 1). Adds a
  dialect-agnostic `buildRenderingTechnology(projectId, opts, dialect)` aggregation to `@uptimizr/db`
  that rolls `session_start.graphics` up into `(api, backend, api_version, shading_language)` session
  counts. The fields ride in stored JSON (nothing promoted to a column), so extraction goes through the
  existing `jsonText` helper and blanks coalesce to `''` ("unknown"), covered by a `PARITY_CASES`
  entry. Unlike the opt-in engine-diagnostics rollup this is always-on, so a populated result is the
  common case.

  `@uptimizr/react` gains a `renderingTechnology()` query-client method (and `RenderingTechnologyCount`
  type) hitting the new `GET /api/v1/rendering-technology` collector endpoint, powering the new
  dashboard "Rendering technology" panel beside Engine diagnostics — sessions broken down by API,
  backend, and shading language with no opt-in empty state.

### Patch Changes

- Updated dependencies [08c4abd]
  - @uptimizr/schema@0.4.0

## 0.5.0

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

### Patch Changes

- Updated dependencies [fa6c472]
- Updated dependencies [32248e0]
  - @uptimizr/schema@0.3.0

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
  - @uptimizr/schema@0.2.0

## 0.2.1

### Patch Changes

- df5b66b: chore: point each package's npm `homepage` at its specific docs page (instead of the GitHub tree URL) and add an `author` field across the public manifests.
- Updated dependencies [df5b66b]
  - @uptimizr/schema@0.1.1

## 0.2.0

### Minor Changes

- e78029b: feat: add a single-tenant ClickHouse store (`COLLECTOR_STORE=clickhouse`) for the scale tier. Events and metadata live in one ClickHouse database (no separate service), the schema is created on first boot, and the full analytics surface returns results identical to DuckDB (verified by a cross-engine parity suite). Adds the new `@uptimizr/db-clickhouse` package and the pure `clickhouseDialect` in `@uptimizr/db`. Implements ADR 0020.

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

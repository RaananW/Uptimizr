# @uptimizr/collector-server

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

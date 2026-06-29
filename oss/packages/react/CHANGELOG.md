# @uptimizr/react

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

## 0.5.0

### Minor Changes

- fa6c472: Add a browser/OS performance segment derived from the request User-Agent at
  ingestion (#11). The collector reduces the User-Agent to a coarse, non-PII
  `{ browser, os }` pair (raw UA never stored) and merges it into
  `session_start.device`; `buildPerfByDevice` and the dashboard "FPS by device"
  panel now segment per-session median FPS by browser/OS in addition to graphics
  backend, mobile flag, and GPU renderer. No SDK, schema-capture, or storage
  migration change (ADR 0041).
- ad8addf: feat(dashboard): runtime/remote panel loading (#61)

  The dashboard can now discover and load panels from a remote manifest at runtime — behind the same
  `PanelDefinition` contract — so self-hosters add panels without rebuilding. `@uptimizr/react` gains
  `PANEL_CONTRACT_VERSION` and a framework-agnostic loader (`fetchPanelManifest`, `loadRemotePanels`,
  `mergePanels`, plus manifest/definition guards) with contract-version gating, an optional origin
  allowlist, and per-entry error isolation. The dashboard reads `NEXT_PUBLIC_PANELS_MANIFEST_URL`
  (and optional `NEXT_PUBLIC_PANELS_ALLOWED_ORIGINS`), merges remote panels with the built-ins,
  surfaces load failures in a banner, and hardens `PanelHost` with a guarded `enabled()` and a
  per-panel render error boundary so a misbehaving panel never breaks the grid. Off by default;
  build-time registration is unchanged.

## 0.4.0

### Minor Changes

- 69a80a9: feat(dashboard): viewer-configurable panels — hide/show with restore plus typed per-panel settings (#79)

  Panels can now be hidden and restored (always reversible, viewer-local) and expose typed settings
  (`number`/`boolean`/`select`) via a generic `PanelDefinition`/`PanelContext` contract. Settings are
  resolved with declared defaults overlaid by saved overrides through a swappable `PanelStateStore`
  seam, and `usePanelData` refetches on settings change. Built-in data-resolution settings ship for
  the floor-plan, view-direction dome, world/voxel heatmap, pointer heatmap, click flow, and top-meshes
  panels.

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

- 605abf8: feat: add three more built-in dashboard panels via the ADR 0036 panel contract.

  - **Navigation-style mix** (`navigation-mix`, #69): a half-width breakdown of camera-gesture
    kinds (orbit / pan / dolly / zoom / roll / fly) with per-kind share and average gesture
    duration. Backed by a new `CollectorApi.cameraGestures()` client method on `@uptimizr/react`
    over the existing `/api/v1/camera-gestures` endpoint.
  - **Flow Sankey (3D)** (`flow-sankey-3d`, #68): the direction-bin → mesh (and standpoint → gaze
    → mesh) flow renderer is now a full-width, client-only `PanelDefinition`; the panel owns its
    walk/orbit/all camera-mode toggle, so the base query drops the global camera-mode filter.
  - **Gaze vs. click divergence** (`gaze-click-divergence-3d`, #70): a full-width, client-only
    overlay of world-space gaze voxels (cool) against click voxels (warm) at a shared cell size,
    with overlay / gaze / click / divergence view modes.

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

## 0.2.0

### Minor Changes

- 8f14077: feat(react): add the extensible dashboard panel contract — `PanelDefinition`, `PanelContext`, `definePanel`, and `usePanelData`, plus shared filter (`FilterState`, `toQueryParams`, …) and `LiveEvent` helpers — so the dashboard and embeds can register custom panels (ADR 0036)

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

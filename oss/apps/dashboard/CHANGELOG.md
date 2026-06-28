# @uptimizr/dashboard

## 0.3.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [fa6c472]
- Updated dependencies [ad8addf]
  - @uptimizr/react@0.5.0
  - @uptimizr/replay@0.2.1

## 0.2.0

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

- c2d73bf: feat(replay): load a `.glb` backdrop and re-drive a session over it (#80)

  Add a Babylon-only scene-backdrop loader so replay can bring its own scene when the host has none
  (e.g. a hosted drag-and-drop viewer). Exposed two ways: a standalone
  `loadSceneBackdrop(scene, source, options?)` from `@uptimizr/replay/babylon` (accepts a URL or a
  dropped `File`, returns a disposable `{ rootNodes, meshes, container, dispose() }` handle), and a
  `backdropUrl` option on the global `replayInScene`. The npm helper lazily imports Babylon's glTF
  `SceneLoader`, and the global path reuses the host page's loader, so neither the lean driver path
  nor the IIFE build bundles a second copy of the loader. Loaded actor/subtree nodes re-drive exactly
  like any other scene node (`node_transform`, ADR 0033).

  The dashboard's **Session replay** birdview gains a no-code **Load model (.glb)** control: load a
  glTF to replace the wireframe AABB proxy boxes with the real model and re-drive the session over it
  (replace/remove restores the boxes). The model is loaded in the browser only — nothing is uploaded.

### Patch Changes

- Updated dependencies [69a80a9]
- Updated dependencies [b5c7eac]
- Updated dependencies [c2d73bf]
  - @uptimizr/react@0.4.0
  - @uptimizr/replay@0.2.0

## 0.1.3

### Patch Changes

- 2fe65d2: fix(dashboard): keep panel bodies mounted during live refresh so panels no longer "jump"

  Registry-driven panels collapsed to a one-line "Loading…" placeholder on every background refetch
  (live `revision` bumps, filter changes) and then re-expanded once the data arrived, making the
  dashboard visibly jump. `PanelHost` now only shows the loading placeholder while a panel has no
  data to render yet — once data is present, refreshes keep the last-rendered body on screen and the
  chart redraws in place. Gating on data presence (instead of a "settled once" flag) also fixes a
  crash where a panel could render with null data after a transient load error cleared on the next
  refetch.

- d858ccf: feat(dashboard): register the floor-plan dwell heatmap as a built-in panel (ADR 0036). The top-down camera-position heatmap is now a reusable `PanelDefinition` in `builtinPanels`, so embedders of `@uptimizr/react` get it too. It stays hidden in the orbit/"viewer" camera mode and renders on both the overview and session surfaces.
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

- adb2977: feat(dashboard): focus the 3D orbit camera on a double-clicked scene point, with a recenter button
  to reset focus back to the scene center (#91). The ArcRotateCamera panels previously always orbited
  a fixed center, which is awkward in large walkable scenes — now double-clicking re-centers the orbit
  pivot on the picked point and the recenter control restores the default target and framing. Applies
  to the world/gaze heatmaps, click rays, gaze-vs-click divergence, view-direction dome, and both Flow
  Sankey camera modes.
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

- d858ccf: feat(dashboard): register the world-space (3D) click heatmap as a built-in panel (ADR 0036).
  Extracts a body-only `WorldHeatmap3DView` and wires a `world-heatmap-3d` `PanelDefinition`
  that resolves the scene-proxy backdrop (ADR 0014) alongside its voxels, dropping the legacy
  overview mount (the gaze heatmap keeps its existing mount).
- Updated dependencies [9e22ebd]
- Updated dependencies [605abf8]
- Updated dependencies [394d5c8]
- Updated dependencies [e5ce02c]
  - @uptimizr/react@0.3.0
  - @uptimizr/replay@0.1.2

## 0.1.2

### Patch Changes

- Updated dependencies [8f14077]
  - @uptimizr/react@0.2.0

## 0.1.1

### Patch Changes

- df5b66b: chore: point each package's npm `homepage` at its specific docs page (instead of the GitHub tree URL) and add an `author` field across the public manifests.
- Updated dependencies [df5b66b]
  - @uptimizr/replay@0.1.1
  - @uptimizr/heatmap@0.1.1
  - @uptimizr/react@0.1.1

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
  - @uptimizr/react@0.1.0
  - @uptimizr/replay@0.1.0
  - @uptimizr/heatmap@0.1.0

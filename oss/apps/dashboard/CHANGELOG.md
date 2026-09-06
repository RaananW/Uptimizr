# @uptimizr/dashboard

## 1.1.0

### Minor Changes

- 9330655: Every remaining hand-mounted dashboard panel now lives in the `@uptimizr/react` catalog, completing the ADR 0036 / ADR 0047 migration: event volume over time (with the time-window brush), scene health, engine diagnostics, rendering technology, scene traversal, rendering-performance summary, the six dedicated performance panels (frame time, jank, FPS by device, FPS by scene, stability, resource footprint), input sources, the 2D view-direction heatmap, the 3D gaze heatmap and click rays (code-split like the other Babylon panels), and the sessions table. Each is exported individually, is hideable and, where it has knobs, configurable from the ⚙ menu; the 3D gaze/click-ray panels gain a voxel-size setting. The duplicated FPS-distribution card is gone (the catalog's performance-distribution panel already showed it).

  `PanelDefinition` gains an optional `defaultCollapsed`, and `PanelActions` an optional `clearTimeRange` (undo a brush and restore the previous preset). Both are additive; the panel contract major is unchanged. The dashboard page is now a pure shell — connection form, filters, scene selector, session inspector, replay and live-presence mounts, live wiring — and its per-page aggregate fetch is gone.

- 9330655: Walked path panel: color-code the session trajectory by camera height (world Y) using the shared Ember heat ramp, with a legend showing the lowest and highest points on the route. Ramps, stairs, lifts, and multi-floor routes now read in the top-down plan view instead of looking like adjacent points on one floor (#92). Paths whose height varies by less than 0.25 m stay a single color and say so, and a per-viewer **Color by height** setting turns the encoding off.

  The panel now lives in the portable catalog as `walkedPathPanel` (`WalkedPathView` and the height helpers are exported too) instead of being hand-mounted by the dashboard. To support that, `PanelContext` gains an optional `session` field carrying the inspected session's metadata on the session surface, and `SessionMeta.scene.cameraType` is typed. Both changes are additive; the panel contract major is unchanged.

### Patch Changes

- a2c75cd: Refresh runtime dependencies: Fastify 5.12.3 (collector-server) and Next.js 16.3.4 (dashboard). The workspace lockfile now resolves `qs` 6.16.0, clearing GHSA-x5fp-wj9c-mxmx and GHSA-4mjr-xmp4-gh2g.
- Updated dependencies [9330655]
- Updated dependencies [9330655]
- Updated dependencies [9330655]
  - @uptimizr/react@1.1.0

## 1.0.0

### Major Changes

- 9dd78e8: Uptimizr 1.0.0 — first stable release. Every package moves to 1.0.0 together; from here on the public API, the versioned event schema, and the collector's HTTP API follow semantic versioning (a breaking change is a major). Highlights since the public beta: six stable live-JS connectors (Babylon.js, Babylon Lite, three.js, react-three-fiber, PlayCanvas, A-Frame/WebXR) with per-engine capture parity and end-to-end coverage; WebXR in-scene hit resolution; three optional multi-writer stores (ClickHouse, PostgreSQL, SQL Server) behind the same `CollectorStore` contract with cross-engine parity tests; the in-browser analytics assistant with a local (WebLLM) or hosted model, tool-calling over the read-only analytics catalog, and streamed replies; and the MCP server for desktop AI clients. No wire-format or API changes are bundled with this bump — it marks the point where they become breaking.

### Patch Changes

- Updated dependencies [8194192]
- Updated dependencies [4bf345a]
- Updated dependencies [9dd78e8]
- Updated dependencies [6b6a2fe]
  - @uptimizr/react@1.0.0
  - @uptimizr/replay@1.0.0
  - @uptimizr/heatmap@1.0.0

## 0.4.8

### Patch Changes

- 0af8209: Update runtime dependencies: Fastify 5.12.1 and @fastify/helmet 13.1.1 (collector-server), Next.js 16.3.3 and Babylon.js 9.23.0 (dashboard), and Zod 4.5.4 (schema, agent-core, mcp, replay, collector-server). Dev-only dependency bumps across the remaining packages are not released.
- Updated dependencies [0af8209]
  - @uptimizr/replay@0.2.6
  - @uptimizr/react@0.13.1

## 0.4.7

### Patch Changes

- db76d60: Update runtime dependencies: Fastify 5.12 / @fastify/static 10.1.3 (collector-server), Next.js 16.3.1, Babylon.js 9.21.2 and WebLLM 0.2.84 (dashboard), and DuckDB node-api 1.5.5-r.4 (db). Dev-only dependency bumps across the remaining packages are not released.

## 0.4.6

### Patch Changes

- fa842eb: Update runtime dependencies to their latest releases: Fastify and its rate-limit
  plugin (collector-server), Babylon.js core and loaders (dashboard), and the DuckDB
  Node API (db). Development-only tooling across the workspace was refreshed to latest
  as well; TypeScript is intentionally held back pending the 7.x migration.
- Updated dependencies [0e8b8a8]
- Updated dependencies [6d883d0]
- Updated dependencies [8041ca2]
  - @uptimizr/react@0.13.0
  - @uptimizr/replay@0.2.5

## 0.4.5

### Patch Changes

- Updated dependencies [d5b1f23]
  - @uptimizr/react@0.12.1

## 0.4.4

### Patch Changes

- Updated dependencies [dd34af8]
  - @uptimizr/react@0.12.0

## 0.4.3

### Patch Changes

- Updated dependencies [59b12c5]
- Updated dependencies [8ec1cdb]
  - @uptimizr/react@0.11.3

## 0.4.2

### Patch Changes

- Updated dependencies [a6eb8c7]
  - @uptimizr/react@0.11.2

## 0.4.1

### Patch Changes

- @uptimizr/react@0.11.1

## 0.4.0

### Minor Changes

- 14c9bcf: feat(dashboard): embed the in-browser analytics assistant (ADR 0050, closes #193)

  The dashboard now ships an "Analytics assistant" drawer that mounts the portable
  `<AssistantPanel>` from `@uptimizr/react/assistant`, wired to the active project's
  real collector connection (same read-only query API + key the panels use). Ask
  natural-language questions of your analytics and get grounded, tool-backed
  answers.

  The panel and the WebLLM runtime (`@mlc-ai/web-llm`) are **fully code-split**:
  they load on demand only when a visitor opens the assistant, so the main bundle
  is unchanged for everyone else (guarded by an entry-purity test). Model weights
  download on first use behind a consent gate — never eagerly, never precached.

  Because the backend-less demo embeds this dashboard build, the same assistant
  now works there against the in-browser service-worker / DuckDB-Wasm query layer —
  no server and no API key, with a local WebLLM model.

### Patch Changes

- 59fd29b: docs: refresh package and app READMEs to match current source

  Reconcile every package/app README with the actual code — corrected package/connector
  lists, public APIs and options, CLI flags, env vars, ports, the event catalog, and
  cross-links. Also drop "Google Analytics" references in favor of neutral "web analytics"
  wording. Documentation-only; no runtime behavior changes.

- Updated dependencies [90e1bea]
- Updated dependencies [306f5ab]
- Updated dependencies [59fd29b]
  - @uptimizr/react@0.11.0
  - @uptimizr/heatmap@0.1.3
  - @uptimizr/replay@0.2.4

## 0.3.6

### Patch Changes

- Updated dependencies [cb8d377]
  - @uptimizr/react@0.10.0

## 0.3.5

### Patch Changes

- Updated dependencies [02e5ac8]
  - @uptimizr/react@0.9.0

## 0.3.4

### Patch Changes

- c4863de: fix(react,dashboard): stop 3D panels re-rendering and resetting the camera on every data refresh

  The Babylon 3D analytics panels rebuilt their entire engine/scene on every
  data update, which flickered ("Rendering…") and snapped the user's orbit
  camera back to its default framing several times per second on the live
  demo/session views. Each view now initializes the scene **once** and repaints
  only the data-driven content in place — the camera is framed a single time at
  build and is never reset by a live refresh.

  - @uptimizr/react: split the single data-keyed effect in every 3D view
    (`WorldHeatmap3D`, `CameraDome3D`, `ClickRays3D`, `GazeClickDivergence3D`,
    `FlowSankey3D`) into a lifecycle effect (engine/scene/camera/lights, framed
    once) plus an in-place data-sync effect that repaints thin-instance buffers /
    content meshes without touching the camera. Latest data is read through refs;
    the faint proxy backdrop is rebuilt only when the scene geometry actually
    changes.
  - @uptimizr/react: fix `MeshUvHeatmap` (2D) flicker — keep the last rendered
    canvas on screen during a background refetch instead of swapping in a
    "Loading…" placeholder every refresh.
  - @uptimizr/dashboard: refresh live-session panels while a session drill-down is
    open so their data updates in real time instead of only after navigating away
    and back.

- Updated dependencies [c4863de]
  - @uptimizr/react@0.8.1

## 0.3.3

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
  - @uptimizr/react@0.8.0
  - @uptimizr/replay@0.2.3

## 0.3.2

### Patch Changes

- Updated dependencies [dc740f3]
  - @uptimizr/react@0.7.0

## 0.3.1

### Patch Changes

- Updated dependencies [a580f5e]
- Updated dependencies [c8887f7]
- Updated dependencies [d71b284]
  - @uptimizr/react@0.6.0
  - @uptimizr/replay@0.2.2
  - @uptimizr/heatmap@0.1.2

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

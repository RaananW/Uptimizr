# @uptimizr/babylon

## 0.5.0

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

- Updated dependencies [0e8b8a8]
- Updated dependencies [6d883d0]
- Updated dependencies [8041ca2]
  - @uptimizr/schema@0.6.0
  - @uptimizr/sdk-core@0.5.0

## 0.4.1

### Patch Changes

- 59fd29b: docs: refresh package and app READMEs to match current source

  Reconcile every package/app README with the actual code — corrected package/connector
  lists, public APIs and options, CLI flags, env vars, ports, the event catalog, and
  cross-links. Also drop "Google Analytics" references in favor of neutral "web analytics"
  wording. Documentation-only; no runtime behavior changes.

- Updated dependencies [59fd29b]
  - @uptimizr/schema@0.5.1
  - @uptimizr/sdk-core@0.4.1

## 0.4.0

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

### Patch Changes

- Updated dependencies [e39cbc7]
- Updated dependencies [3c0a20b]
- Updated dependencies [3193a21]
  - @uptimizr/schema@0.5.0
  - @uptimizr/sdk-core@0.4.0

## 0.3.0

### Minor Changes

- 092ef4b: Capture WebGL/WebGPU **context-creation failure** as a `graphics_diagnostic`
  (`category: context-loss`, `severity: fatal`, ADR 0021 part 2, #18). At connector init the
  Babylon (`@uptimizr/babylon`) and three (`@uptimizr/three`) connectors check whether the engine
  obtained a usable backend (no WebGL context / `getContext()` null); if not, they emit one discrete
  marker (no `count`) with `backend: "unknown"` where it can't be determined. The shared, engine-
  agnostic emission (gating, length-cap, event shape) lands in `@uptimizr/sdk-core` as the new
  `wireContextCreationFailure` helper. Capture is gated by the existing `captureGraphicsDiagnostics`
  opt-in (off by default). The marker fires before the first transport flush, but because the client
  sets `started` before running collectors it queues right after `session_start` and survives flush.

  No deterministic headless trigger exists for a context-creation failure, so this slice is covered by
  sdk-core + connector unit tests (including a pre-transport flush regression) rather than a Playwright
  E2E.

- 16fc907: Capture shader compile/link failures and sampled `gl.getError()` as `graphics_diagnostic`
  (ADR 0021 part 2, #17). The Babylon (`@uptimizr/babylon`) and three (`@uptimizr/three`)
  connectors now emit `category: "shader-compile"` (`error`) on a failed WebGL
  `compileShader`/`linkProgram` (via `getShaderInfoLog`/`getProgramInfoLog`) and WebGPU
  shader-module compilation errors, plus a rate-limited `category: "validation"` rollup from
  opportunistically sampled WebGL `gl.getError()` — never per-frame, since `getError` forces a
  sync GPU stall. New `@uptimizr/sdk-core` helpers (`wireGlShaderDiagnostics`,
  `wireGpuShaderDiagnostics`, `wireGlErrorSampling`, `buildShaderCompileDiagnostic`) keep the
  gating, redaction, and event shape in one place.

  Both signals stay gated by the existing `captureGraphicsDiagnostics` opt-in (off by default).
  Shader info logs can embed shader source, so raw source is stripped unless the new
  `captureShaderSource` sub-opt-in (default false) is set — application IP, per ADR 0021. All text
  is length-capped and routed through `beforeSend`. WebGPU is a no-op for `gl.getError()`.

  Covered by sdk-core + connector unit tests (redaction default vs opt-in, rate-limited sampling,
  both off by default); a deterministic headless trigger isn't available, so no Playwright E2E.

- 73f342d: Capture WebGPU `GPUDevice.lost` as a `graphics_diagnostic` (`category: device-lost`,
  ADR 0021 part 2, #20). The Babylon (`@uptimizr/babylon`) and three (`@uptimizr/three`)
  connectors subscribe to the WebGPU device-lost promise and emit one diagnostic with
  `backend: "webgpu"` and `severity` `info` for a requested loss (`reason: "destroyed"`)
  or `fatal` for an unrequested one; the optional `message` is length-capped and routed
  through `beforeSend`. Capture is gated by the existing `captureGraphicsDiagnostics`
  opt-in (off by default); WebGL renderers are a no-op (their interruption stays the
  always-on `context_lost`). The shared, engine-agnostic emission logic (gating, severity
  mapping, length-cap, event shape) lands in `@uptimizr/sdk-core` as the new
  `wireGpuDeviceLost` helper so connectors stay thin.

  A real WebGPU device loss can't be triggered deterministically in headless CI, so this
  slice is covered by connector + sdk-core unit tests rather than a Playwright E2E (the
  playground capture matrix runs WebGL only).

- 23f308d: Capture WebGPU `uncapturederror` as a **rate-limited per-session rollup**
  `graphics_diagnostic` (ADR 0021 part 2, #19). The Babylon (`@uptimizr/babylon`) and three
  (`@uptimizr/three`) connectors listen for `uncapturederror` on the WebGPU device and
  aggregate a burst into a single event carrying `count: N` plus the first message —
  flushed on an interval and on stop/dispose, so an error storm never floods ingestion.
  Subtype maps to `category: "out-of-memory"` (`GPUOutOfMemoryError`, `severity: error`)
  or `category: "validation"` (`severity: warning`); `message` is length-capped and routed
  through `beforeSend`. Capture is gated by the existing `captureGraphicsDiagnostics` opt-in
  (off by default); WebGL is a no-op. The shared, engine-agnostic rollup/flush helper lands
  in `@uptimizr/sdk-core` as `wireGpuUncapturedError` so future signals reuse it.

  A WebGPU error storm can't be triggered deterministically in headless CI, so this slice
  is covered by connector + sdk-core unit tests rather than a Playwright E2E.

### Patch Changes

- d71b284: Roll up the open Dependabot updates into a single dependency bump. Refresh
  engine peers and tooling (Babylon.js 9.14, Babylon Lite 1.6, three.js 0.185,
  PlayCanvas 2.20, @clickhouse/client 1.22, fastify-type-provider-zod 7,
  fastify 5.9, astro 7, @types/node 26, plus the minor/patch group and CI
  actions). No public API changes. Babylon Lite 1.6 reads WebGPU bitmask
  globals at import time, so the lite connector's vitest run now stubs those
  globals via a setup file.
- 268ea8f: Reliably capture WebGPU `device.lost` when the GPU device initializes
  asynchronously. WebGPU backends build their `GPUDevice` after the collector
  starts (three's `renderer.init()` / first `renderAsync`, Babylon's `initAsync`),
  so reading the device once at `start()` could silently miss the loss. The shared
  `wireGpuDeviceLost` helper now takes a device getter and polls (bounded) until
  the device appears, with cooperative teardown so nothing emits after the
  collector stops. No public API change; the opt-in `captureGraphicsDiagnostics`
  gate and `graphics_diagnostic` shape are unchanged.
- Updated dependencies [092ef4b]
- Updated dependencies [08c4abd]
- Updated dependencies [16fc907]
- Updated dependencies [268ea8f]
- Updated dependencies [73f342d]
- Updated dependencies [23f308d]
  - @uptimizr/sdk-core@0.3.0
  - @uptimizr/schema@0.4.0

## 0.2.0

### Minor Changes

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

- 76a8060: refactor(connectors): move per-frame aggregation math into one sdk-core Aggregator (#10)

  Per-frame aggregation (frame-time percentiles, transform decomposition idle-diffing,
  mesh-visibility bucketing, camera-gesture classification) now lives in one engine-agnostic
  `Aggregator` in `@uptimizr/sdk-core`; the Babylon, Babylon-lite, three.js and PlayCanvas connectors
  become thin snapshot emitters that hand the aggregator plain-number (typed-array-backed) snapshots.
  `@uptimizr/sdk-core` gains an opt-in `offload: "worker"` client option that runs the aggregator —
  plus serialization and dispatch — in a same-origin worker, keeping the render thread free. The
  default (`"main"`) path is byte-for-byte identical to before and is guarded by the connector unit
  tests. See ADR 0044.

- Updated dependencies [fa6c472]
- Updated dependencies [76a8060]
- Updated dependencies [32248e0]
  - @uptimizr/schema@0.3.0
  - @uptimizr/sdk-core@0.2.0

## 0.1.2

### Patch Changes

- Updated dependencies [9e22ebd]
  - @uptimizr/schema@0.2.0
  - @uptimizr/sdk-core@0.1.2

## 0.1.1

### Patch Changes

- df5b66b: chore: point each package's npm `homepage` at its specific docs page (instead of the GitHub tree URL) and add an `author` field across the public manifests.
- Updated dependencies [df5b66b]
  - @uptimizr/sdk-core@0.1.1
  - @uptimizr/schema@0.1.1

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
  - @uptimizr/sdk-core@0.1.0

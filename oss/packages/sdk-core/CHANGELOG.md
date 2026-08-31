# @uptimizr/sdk-core

## 0.5.1

### Patch Changes

- Updated dependencies [0af8209]
  - @uptimizr/schema@0.6.1

## 0.5.0

### Minor Changes

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

## 0.4.1

### Patch Changes

- 59fd29b: docs: refresh package and app READMEs to match current source

  Reconcile every package/app README with the actual code — corrected package/connector
  lists, public APIs and options, CLI flags, env vars, ports, the event catalog, and
  cross-links. Also drop "Google Analytics" references in favor of neutral "web analytics"
  wording. Documentation-only; no runtime behavior changes.

- Updated dependencies [59fd29b]
  - @uptimizr/schema@0.5.1

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

- 08c4abd: Add the `graphics_diagnostic` event contract and the `captureGraphicsDiagnostics`
  opt-in flag (ADR 0021 part 2, foundation). The new event is a single
  engine-agnostic GPU-health signal with `severity`, `category`, optional `backend`
  (reusing the `graphics.api` enum), length-capped `message`/`code`, and a `count`
  field that discriminates a discrete incident marker from an aggregated per-session
  rollup. Capture is gated by the new `captureGraphicsDiagnostics` flag in
  `@uptimizr/sdk-core`, **off by default** (mirroring `captureErrors`);
  `context_lost`/`context_restored` stay always-on and exempt. No connector capture
  wiring yet — that lands in the per-signal slices.
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

- 268ea8f: Reliably capture WebGPU `device.lost` when the GPU device initializes
  asynchronously. WebGPU backends build their `GPUDevice` after the collector
  starts (three's `renderer.init()` / first `renderAsync`, Babylon's `initAsync`),
  so reading the device once at `start()` could silently miss the loss. The shared
  `wireGpuDeviceLost` helper now takes a device getter and polls (bounded) until
  the device appears, with cooperative teardown so nothing emits after the
  collector stops. No public API change; the opt-in `captureGraphicsDiagnostics`
  gate and `graphics_diagnostic` shape are unchanged.
- Updated dependencies [08c4abd]
  - @uptimizr/schema@0.4.0

## 0.2.0

### Minor Changes

- 76a8060: refactor(connectors): move per-frame aggregation math into one sdk-core Aggregator (#10)

  Per-frame aggregation (frame-time percentiles, transform decomposition idle-diffing,
  mesh-visibility bucketing, camera-gesture classification) now lives in one engine-agnostic
  `Aggregator` in `@uptimizr/sdk-core`; the Babylon, Babylon-lite, three.js and PlayCanvas connectors
  become thin snapshot emitters that hand the aggregator plain-number (typed-array-backed) snapshots.
  `@uptimizr/sdk-core` gains an opt-in `offload: "worker"` client option that runs the aggregator —
  plus serialization and dispatch — in a same-origin worker, keeping the render thread free. The
  default (`"main"`) path is byte-for-byte identical to before and is guarded by the connector unit
  tests. See ADR 0044.

### Patch Changes

- Updated dependencies [fa6c472]
- Updated dependencies [32248e0]
  - @uptimizr/schema@0.3.0

## 0.1.2

### Patch Changes

- Updated dependencies [9e22ebd]
  - @uptimizr/schema@0.2.0

## 0.1.1

### Patch Changes

- df5b66b: chore: point each package's npm `homepage` at its specific docs page (instead of the GitHub tree URL) and add an `author` field across the public manifests.
- Updated dependencies [df5b66b]
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

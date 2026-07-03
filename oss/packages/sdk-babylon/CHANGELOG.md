# @uptimizr/babylon

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

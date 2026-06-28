# @uptimizr/babylon

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

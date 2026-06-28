# @uptimizr/sdk-core

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

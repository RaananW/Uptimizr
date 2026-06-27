---
"@uptimizr/sdk-core": minor
"@uptimizr/babylon": patch
"@uptimizr/babylon-lite": patch
"@uptimizr/three": patch
"@uptimizr/playcanvas": patch
---

refactor(connectors): move per-frame aggregation math into one sdk-core Aggregator (#10)

Per-frame aggregation (frame-time percentiles, transform decomposition idle-diffing,
mesh-visibility bucketing, camera-gesture classification) now lives in one engine-agnostic
`Aggregator` in `@uptimizr/sdk-core`; the Babylon, Babylon-lite, three.js and PlayCanvas connectors
become thin snapshot emitters that hand the aggregator plain-number (typed-array-backed) snapshots.
`@uptimizr/sdk-core` gains an opt-in `offload: "worker"` client option that runs the aggregator —
plus serialization and dispatch — in a same-origin worker, keeping the render thread free. The
default (`"main"`) path is byte-for-byte identical to before and is guarded by the connector unit
tests. See ADR 0044.

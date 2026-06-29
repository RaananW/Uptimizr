---
"@uptimizr/sdk-core": minor
"@uptimizr/babylon": minor
"@uptimizr/three": minor
---

Capture WebGPU `uncapturederror` as a **rate-limited per-session rollup**
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

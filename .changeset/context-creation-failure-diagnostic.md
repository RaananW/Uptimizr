---
"@uptimizr/sdk-core": minor
"@uptimizr/babylon": minor
"@uptimizr/three": minor
---

Capture WebGL/WebGPU **context-creation failure** as a `graphics_diagnostic`
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

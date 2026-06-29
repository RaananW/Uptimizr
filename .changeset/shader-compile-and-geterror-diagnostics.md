---
"@uptimizr/sdk-core": minor
"@uptimizr/babylon": minor
"@uptimizr/three": minor
---

Capture shader compile/link failures and sampled `gl.getError()` as `graphics_diagnostic`
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

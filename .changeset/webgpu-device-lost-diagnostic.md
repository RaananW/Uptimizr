---
"@uptimizr/sdk-core": minor
"@uptimizr/babylon": minor
"@uptimizr/three": minor
---

Capture WebGPU `GPUDevice.lost` as a `graphics_diagnostic` (`category: device-lost`,
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

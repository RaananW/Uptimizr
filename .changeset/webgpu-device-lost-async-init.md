---
"@uptimizr/sdk-core": patch
"@uptimizr/babylon": patch
"@uptimizr/three": patch
---

Reliably capture WebGPU `device.lost` when the GPU device initializes
asynchronously. WebGPU backends build their `GPUDevice` after the collector
starts (three's `renderer.init()` / first `renderAsync`, Babylon's `initAsync`),
so reading the device once at `start()` could silently miss the loss. The shared
`wireGpuDeviceLost` helper now takes a device getter and polls (bounded) until
the device appears, with cooperative teardown so nothing emits after the
collector stops. No public API change; the opt-in `captureGraphicsDiagnostics`
gate and `graphics_diagnostic` shape are unchanged.

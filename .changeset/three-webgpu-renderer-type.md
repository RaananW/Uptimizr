---
"@uptimizr/three": patch
"@uptimizr/r3f": patch
---

`trackScene`, `threeCollector`, `readDeviceCaps` and `readGraphics` now accept a `WebGPURenderer` without a cast. `renderer` is typed as the new structural `ThreeRenderer`, which both `WebGLRenderer` and `WebGPURenderer` satisfy, instead of `WebGLRenderer`.

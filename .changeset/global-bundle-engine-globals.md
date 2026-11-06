---
"@uptimizr/three": patch
"@uptimizr/aframe": patch
"@uptimizr/playcanvas": patch
"@uptimizr/babylon-lite": patch
---

Fix the script-tag bundles, which threw `Dynamic require of "three" is not supported` at load and never defined their global. They now look the engine up on `window.THREE`, `window.pc` or `window.BabylonLite` when first used, and `trackScene` throws a clear error if the global is missing. The bundles still never include the engine.

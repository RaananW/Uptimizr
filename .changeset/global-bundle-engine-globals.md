---
"@uptimizr/three": patch
"@uptimizr/aframe": patch
"@uptimizr/playcanvas": patch
"@uptimizr/babylon-lite": patch
---

Fix the script-tag bundles, which threw `Dynamic require of "three" is not supported` at load and never defined their global. They now look the engine up on its global when first used, and `trackScene` throws a clear error if it is missing. The bundles still never include the engine. Pages with no bundler that use ES modules should use the existing ESM bundles with an import map, which needs no global. None of this affects npm and bundler users.

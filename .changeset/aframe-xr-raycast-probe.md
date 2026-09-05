---
"@uptimizr/three": minor
"@uptimizr/aframe": minor
---

XR in-scene hit resolution. `@uptimizr/three` adds `createXrRaycaster(scene, { maxDistance, predicate })`, a world-space ray probe for the WebXR collector's `xr.raycast` option. `@uptimizr/aframe` now supplies it by default, so controller/gaze ray samples carry `hitPoint`/`hitMesh` and select/squeeze attach a `mesh_interaction` to the object hit; set `xrRaycast: false` on the component to capture rays and clicks only.

---
"@uptimizr/sdk-core": minor
"@uptimizr/three": patch
"@uptimizr/playcanvas": patch
"@uptimizr/babylon-lite": patch
"@uptimizr/web-export": patch
---

Stop recording a camera drag as a click. The browser fires `click` after any press and release, so an orbit or pan drag ended in a `pointer_click` (and a `mesh_interaction` pick) on three.js, react-three-fiber, A-Frame, PlayCanvas, Babylon Lite and web exports. A release more than 10 CSS px from its press is now a drag, matching Babylon's `Scene.DragMovementThreshold`. `@uptimizr/sdk-core` exports the rule as `createClickGuard()` and `CLICK_DRAG_THRESHOLD_PX` for custom collectors.

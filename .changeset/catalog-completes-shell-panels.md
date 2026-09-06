---
"@uptimizr/react": minor
"@uptimizr/dashboard": minor
---

Every remaining hand-mounted dashboard panel now lives in the `@uptimizr/react` catalog, completing the ADR 0036 / ADR 0047 migration: event volume over time (with the time-window brush), scene health, engine diagnostics, rendering technology, scene traversal, rendering-performance summary, the six dedicated performance panels (frame time, jank, FPS by device, FPS by scene, stability, resource footprint), input sources, the 2D view-direction heatmap, the 3D gaze heatmap and click rays (code-split like the other Babylon panels), and the sessions table. Each is exported individually, is hideable and, where it has knobs, configurable from the ⚙ menu; the 3D gaze/click-ray panels gain a voxel-size setting. The duplicated FPS-distribution card is gone (the catalog's performance-distribution panel already showed it).

`PanelDefinition` gains an optional `defaultCollapsed`, and `PanelActions` an optional `clearTimeRange` (undo a brush and restore the previous preset). Both are additive; the panel contract major is unchanged. The dashboard page is now a pure shell — connection form, filters, scene selector, session inspector, replay and live-presence mounts, live wiring — and its per-page aggregate fetch is gone.

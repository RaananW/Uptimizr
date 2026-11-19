---
"@uptimizr/babylon": minor
---

Pick pointer moves with the connector's own bounded `scene.pick` instead of Babylon's lazy move pick, so `hover_dwell` and `pointer_move.hitMesh` work on ordinary meshes and throttled moves no longer cost a ray cast; adds `hoverDwell.pickIntervalMs` (default 100).

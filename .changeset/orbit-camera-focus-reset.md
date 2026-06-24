---
"@uptimizr/dashboard": patch
---

feat(dashboard): focus the 3D orbit camera on a double-clicked scene point, with a recenter button
to reset focus back to the scene center (#91). The ArcRotateCamera panels previously always orbited
a fixed center, which is awkward in large walkable scenes — now double-clicking re-centers the orbit
pivot on the picked point and the recenter control restores the default target and framing. Applies
to the world/gaze heatmaps, click rays, gaze-vs-click divergence, view-direction dome, and both Flow
Sankey camera modes.

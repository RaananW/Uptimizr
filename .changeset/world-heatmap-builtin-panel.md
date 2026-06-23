---
"@uptimizr/dashboard": patch
---

feat(dashboard): register the world-space (3D) click heatmap as a built-in panel (ADR 0036).
Extracts a body-only `WorldHeatmap3DView` and wires a `world-heatmap-3d` `PanelDefinition`
that resolves the scene-proxy backdrop (ADR 0014) alongside its voxels, dropping the legacy
overview mount (the gaze heatmap keeps its existing mount).

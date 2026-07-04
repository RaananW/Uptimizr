---
"@uptimizr/schema": minor
"@uptimizr/sdk-core": minor
"@uptimizr/babylon": minor
"@uptimizr/db": minor
"@uptimizr/react": minor
---

feat: add optional `uv` field for a per-mesh texture-space heatmap (#149)

`pointer_click`, `mesh_interaction`, and `hover_dwell` now carry an optional,
unclamped `uv: [u, v]` texture coordinate, captured by the Babylon connector from
the raycast hit (`PickingInfo.getTextureCoordinates()`). It rides in the event
`payload` — additive and backward-compatible, no column promotion or migration.

A new `buildMeshUvHeatmap` query builder and `GET /api/v1/heatmaps/mesh-uv`
endpoint bin a single mesh's `uv` values into a grid, surfaced by the dashboard's
new **Mesh UV heatmap** panel (interactive mesh picker, defaults to the
most-interacted mesh).

---
"@uptimizr/db": minor
"@uptimizr/react": minor
---

feat: blind-spot / never-noticed mesh report (#143)

Add a "blind spots" leaderboard — the inverse of the most-interacted / part-
popularity panels — surfacing meshes that render but are never noticed. A new
`@uptimizr/db` aggregation (`buildMeshBlindSpots`) cross-references
`mesh_visibility` on-screen time against `mesh_interaction` + `hover_dwell`
engagement per mesh, keeping only meshes that were actually visible and ranking
the most-seen-yet-least-touched first. Exposed through the collector's
`GET /api/v1/meshes/blind-spots` endpoint and a new **Blind spots** panel in
`@uptimizr/react`'s `ossPanelCatalog` (`meshBlindSpots` API client +
`BlindSpotReportView`). No schema change — reuses the existing event types.

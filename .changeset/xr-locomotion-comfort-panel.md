---
"@uptimizr/db": minor
"@uptimizr/react": minor
---

feat(dashboard): VR comfort & locomotion panel (#148)

Add an XR-focused locomotion + comfort panel that reuses existing schema (no
schema change). A new `@uptimizr/db` `buildXrLocomotionComfort` builder returns,
per XR session, its fly/navigate gesture counts, `mesh_interaction` teleport
count, total locomotion duration, and wall-clock span. The `@uptimizr/react`
catalog gains an `xrLocomotionComfortPanel` that renders the locomotion-style mix
(teleport vs. smooth locomotion vs. navigate) and a heavy-vs-light-locomotion
early-exit correlation — a motion-discomfort proxy. Exposed via
`GET /api/v1/xr/locomotion`.

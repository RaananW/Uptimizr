---
"@uptimizr/db": minor
"@uptimizr/react": minor
---

feat: add a canned scene/level retention funnel (#147)

A zero-config Sankey preset built directly from `scene_change` markers — session
counts flowing scene → scene in observed order, weighted by distinct sessions, so
level-to-level drop-off is visible without authoring any funnel steps (the
complement to the caller-authored funnel, ADR 0038).

- `@uptimizr/db`: new `buildSceneRetention()` query builder (parity-safe — no
  window functions) plus `SceneRetentionOptions` / `SceneRetentionRow` types.
- `@uptimizr/react`: new `CollectorApi.sceneRetention()` + `SceneRetentionLink`
  type, and a built-in **Scene retention funnel** panel in the OSS catalog.

Served by the collector at `GET /api/v1/scene-retention`.

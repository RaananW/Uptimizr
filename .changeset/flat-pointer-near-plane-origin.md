---
"@uptimizr/schema": minor
"@uptimizr/babylon": minor
"@uptimizr/db": minor
"@uptimizr/db-clickhouse": minor
---

feat: reconstruct near-plane origin for flat-pointer click rays (ADR 0041)

Flat pointers (mouse/touch/stylus) have no native pointing ray, so the click-ray heatmap
(`/api/v1/heatmaps/click-rays`) collapsed every flat click to the nearest `camera_sample`
position. Capture the camera's projection intrinsics and unproject each click's `screen` onto the
camera near plane so flat-pointer rays fan out the way the clicks were actually made.

- **`@uptimizr/schema`** — `camera_sample` gains optional `aspect` and `near` (alongside the
  existing `fov`).
- **`@uptimizr/babylon`** — captures `engine.getAspectRatio(camera)` and `camera.minZ`, emitted
  only when finite and positive.
- **`@uptimizr/db` / `@uptimizr/db-clickhouse`** — `fov`/`aspect`/`near` promoted to dedicated
  columns (forward-only migrations); `buildClickGazeRay` unprojects flat clicks onto the near
  plane using a canonical world-up / no-roll basis.

Pose sources (XR/hand/gaze) keep their native ray origin (ADR 0011); missing intrinsics (legacy
data) or a degenerate look-straight-up/down view fall back to the camera position, so existing
behaviour and parity goldens are unchanged. Additive and non-breaking.

---
"@uptimizr/aframe": minor
---

The `uptimizr` A-Frame component gains `sceneId` (tags every event with a scene/area id, ADR 0010) and `cameraType` (overrides the camera-kind classification recorded on `session_start`, e.g. `arc-rotate` for orbit-style scenes so they are not treated as walkable). Both are optional; invalid `cameraType` values fall back to three's structural classification.

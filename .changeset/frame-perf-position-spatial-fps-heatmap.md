---
"@uptimizr/schema": minor
"@uptimizr/sdk-core": minor
"@uptimizr/babylon": minor
"@uptimizr/db": minor
"@uptimizr/react": minor
---

feat(perf): add optional `position` to `frame_perf` + spatial FPS heatmap (#145)

`frame_perf` samples can now carry the camera world-`position` at the moment
they're taken, so the collector can show _where_ FPS drops, not just _when_. The
Babylon connector fills it automatically from the tracked camera; other
connectors may set it on the emitted event.

- **schema**: `frame_perf.position` is an optional `vec3` (additive,
  backward-compatible — events still validate without it).
- **sdk-core / babylon**: the perf snapshot threads an optional `position`
  through the aggregator into the emitted event; Babylon reads the tracked camera.
- **db**: new dialect-agnostic `buildPerfHeatmap` voxel builder
  (`samples`/`avg_fps`/`min_fps`, ordered `avg_fps ASC`). Reuses the promoted
  `position` column — **no migration**.
- **react**: new `perfHeatmap()` client method + **Performance heatmap (3D)**
  panel (reuses the world-heatmap renderer; hot = slow, honest per-voxel FPS on
  hover).

The collector exposes it at `GET /api/v1/heatmaps/perf`.

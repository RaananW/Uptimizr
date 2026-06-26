---
"@uptimizr/db": minor
"@uptimizr/react": minor
"@uptimizr/collector-server": minor
"@uptimizr/dashboard": minor
---

feat(heatmaps): large-scene spatial resolution (ADR 0040)

Make scenes that are much larger than their walkable area legible without forcing manual
`setScene` segmentation. Four additive, non-breaking pillars:

- **Bounds-driven `cellSize`** — `@uptimizr/db` gains `defaultCellSizeForBounds(bounds, targetCells)`;
  the collector's world/gaze heatmaps derive a sensible voxel size from the selected scene's
  registered world bounds (ADR 0014) — or a `region` box — when `cellSize` is omitted, so big
  scenes no longer collapse into a few coarse blocks. An explicit `cellSize` still wins.
- **Robust normalization** — `@uptimizr/react` exports `percentileMax(counts, p=0.95)`; the
  dashboard's 3D world heatmap normalizes color/size to the 95th-percentile cell so a couple of
  hotspots no longer wash out the rest of the scene.
- **Totals + cold-spots** — new `buildWorldHeatmapStats`/`buildGazeHeatmapStats` builders, store
  methods, and `GET /api/v1/heatmaps/{world,gaze}/stats` routes returning `{ cellSize, cells, hits }`
  (the true occupied-cell + hit counts behind the truncated top-N voxels); the world panel surfaces
  coverage in its legend.
- **Region (AABB) drill-down** — a `region=minX,minY,minZ,maxX,maxY,maxZ` filter (and matching
  `RegionOptions`/`regionClause` in `@uptimizr/db`, `region` in the `@uptimizr/react` client) scopes
  world/gaze/position heatmaps to an axis-aligned box for semantic zoom.

Existing heatmap response shapes are unchanged; the stats endpoints and `region`/auto-`cellSize`
behavior are all additive.

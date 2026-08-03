---
"@uptimizr/schema": minor
"@uptimizr/babylon": minor
"@uptimizr/db": minor
"@uptimizr/collector-server": minor
"@uptimizr/react": minor
---

Add guardian / boundary-touch spatial analytics for room-scale VR (#157, ADR 0048).

- **schema:** new `xr_boundary_proximity` event — a coarse voxel-binned `position` (HMD position at
  the closest approach) plus `durationMs` (time within the near-boundary zone). One event per
  approach; count is implied by frequency.
- **sdk-babylon:** opt-in `babylonBoundaryCollector` detects, entirely on-device, when the tracked
  WebXR pose comes within a near threshold (default 0.5 m) of a bounded reference space's guardian
  boundary and emits one event per approach. The boundary polygon / room geometry is **never**
  transmitted (ADR 0003 / ADR 0048).
- **@uptimizr/db:** dialect-agnostic `buildBoundaryHeatmap`, `buildBoundaryHeatmapStats`, and
  `buildBoundaryContacts` builders that reuse the existing world-heatmap voxel path (no migration —
  the promoted `position` column is reused).
- **collector-server:** new `GET /api/v1/heatmaps/boundary`, `/api/v1/heatmaps/boundary/stats`, and
  `/api/v1/xr/boundary-contacts` endpoints.
- **@uptimizr/react:** a boundary-touch heatmap panel (3D, reusing the world-heatmap render path) and
  a per-session guardian boundary-contacts comfort panel, both registered in the OSS panel catalog.

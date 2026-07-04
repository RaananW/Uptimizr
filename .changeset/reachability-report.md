---
"@uptimizr/db": minor
"@uptimizr/collector-server": minor
"@uptimizr/react": minor
---

feat(db,collector,react): reachability report — per-mesh interaction-distance histogram (#151)

Adds a buildable-now `buildReachability` query that ASOF-joins each `mesh_interaction`
world point to the nearest preceding `camera_sample` and histograms the standpoint→interaction
distance per mesh, surfaced through `GET /api/v1/meshes/reachability`, the `@uptimizr/react`
client, and a new **Reachability report** OSS panel. No schema change.

---
"@uptimizr/db": minor
"@uptimizr/collector-server": minor
"@uptimizr/react": minor
---

Spatial labelling on `format=summary`: world-space heatmap hotspots now carry `region` (the smallest
containing scene region), `regions[]`, `nearestMesh` and `distance`, the `reading` names the place,
and `drill.region` becomes the region id. The 3D panels show the same labels on hover.

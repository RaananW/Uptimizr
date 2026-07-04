---
"@uptimizr/db": minor
"@uptimizr/collector-server": minor
"@uptimizr/react": minor
---

feat: path-retrace / backtracking-ratio leaderboard (#153). Adds a new derived
metric — computed from the existing `camera_sample` position stream, with **no
schema change** — that ranks scenes/areas by how often visitors re-walk the same
area (a confusion signal desire lines don't surface).

- `@uptimizr/db`: new `buildBacktrackRatio(projectId, opts, dialect)` aggregation
  and `BacktrackRatioRow` type. It bins positions onto a coarse X/Z grid
  (`cellSize`, default 2 world units), collapses consecutive dwell samples in one
  cell into ordered _cell entries_ via the `asofLeftJoin` predecessor pattern, and
  pools `backtrack_ratio = revisits ÷ entries` per scene. Cross-engine safe
  (DuckDB + ClickHouse): uses only plain `count()` + a distinct-cell dedup
  subquery and the `present` sentinel for ASOF-LEFT misses. Added to the parity
  suite with golden output.
- `@uptimizr/collector-server`: new `GET /api/v1/backtrack` query route
  (`cellSize`, `limit`, `scene`, `session`) plus the `backtrackRatio` store method
  across the DuckDB, ClickHouse, and memory stores.
- `@uptimizr/react`: new `backtrackRatio()` API client method, `BacktrackRatioStat`
  type, and a **Backtracking hotspots** leaderboard panel (`backtrack-ratio`)
  registered in `ossPanelCatalog` and exported individually.

Additive and non-breaking — every existing export keeps working.

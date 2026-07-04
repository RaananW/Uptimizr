---
"@uptimizr/db": minor
"@uptimizr/collector-server": minor
"@uptimizr/react": minor
---

feat(perf): perf-driven churn overlay — correlate FPS dips / compile stalls with early session end (#144)

Adds a buildable-now "perf-correlated churn rate": of the sessions that ended in
range, the share that ended shortly after an FPS dip (a `frame_perf` sample below
a threshold) or a `compile_stall`, within a configurable window, split by cause.

- `@uptimizr/db`: new dialect-agnostic `buildPerfChurn` aggregation (`PerfChurnRow`)
  derived from existing `frame_perf`, `compile_stall`, `session_end` events — no
  schema change; DuckDB + ClickHouse safe (no window/ASOF functions).
- `@uptimizr/collector-server`: new `GET /api/v1/perf/churn` endpoint
  (`windowMs` / `fpsThreshold` / `stallMs` params) and `Store.perfChurn`.
- `@uptimizr/react`: `CollectorApi.perfChurn` + the "Perf-driven churn" dashboard
  panel with viewer-tunable window / FPS / stall settings.

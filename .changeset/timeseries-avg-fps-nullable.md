---
"@uptimizr/metrics": patch
"@uptimizr/db": patch
"@uptimizr/collector-server": patch
---

`GET /api/v1/timeseries` no longer 500s on a bucket that has events but no
`frame_perf` sample.

`avg` over an empty set is SQL-NULL, so any minute with traffic and no perf
telemetry made the store report `avg_fps: null` — while the metric registry
declared the column non-nullable. The Zod response serialiser rejected the row
and the whole request failed with `FST_ERR_RESPONSE_SERIALIZATION`, which the
dashboard's event-volume panel rendered as "Could not load", taking the
annotation markers on its time axis down with it.

`timeseries.avg_fps` is now `numOrNull`, the registry's own convention for an
aggregate over a possibly-empty set: `null` means "no samples", never `0`. Two
stores were 0-filling it against that convention and now agree with the SQL
ones — the collector's in-memory store, and ClickHouse, whose `avgIf` reports
`0` where every other dialect's `FILTER` / `CASE` form reports NULL (it now
renders `avgIfOrNull`). The dashboard already read the column as
`avg_fps ?? 0`, so nothing changes on screen.

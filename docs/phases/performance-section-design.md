# Design sketch — dashboard performance section

> **Status: shipped.** The dedicated **Performance** section is live in the OSS dashboard — FPS
> distribution, frame-time percentiles, jank, device/scene breakdowns, stability, and footprint —
> backed by the `/api/v1/perf/{distribution,frame-time,jank,by-device,by-scene,stability,resources}`
> endpoints and their `@uptimizr/db` builders. These notes are retained as the design rationale.
> The durable, hard-to-reverse decisions (per-session percentile aggregation, device attribution
> from existing session metadata, column promotion for the jank/frame-time fields) are fixed in
> [ADR 0028](../adr/0028-performance-analytics-and-percentile-aggregation.md). This doc was the
> **map**; each row below was sized to become **one GitHub Issue** (ADR 0016).

## Why now

The "Event volume over time" strip used to overlay an `avg_fps` line on a wall-clock axis. That
mean mixes devices and populations and moves with the audience, not with performance (see
[ADR 0028](../adr/0028-performance-analytics-and-percentile-aggregation.md) §Context). The FPS line
has been removed from that chart; performance now needs a proper home that is honest about the
**distribution** and attributes performance to a **device**.

## What we already have (no capture work)

- **[`frame_perf`](../../oss/packages/schema/src/events/framePerf.ts)** — `fps` (promoted column),
  plus `frameTimeMs`, `frameTimeP95Ms`, `frameTimeP99Ms`, `longFrames`, `drawCalls`, `dpr`,
  `renderScale` (currently in `payload` JSON; promoted to columns per ADR 0028 §3).
- **[`session_start.device`](../../oss/packages/schema/src/events/sessionStart.ts)** — `engine`
  (webgl2/webgpu), GPU `vendor`/`renderer`, `isMobile`, `deviceMemoryGb`, `hardwareConcurrency`.
- **`resource_sample`** — `texture_bytes`, `geometry_bytes`, `triangles`, `vertices`,
  `js_heap_bytes` (all promoted columns).
- **`context_lost` / `context_restored` / `compile_stall`** — own event types; `count()` for
  stability.

## Design principles (carried from ADR 0028 / AGENTS.md)

- **Per-session, then aggregate.** Percentiles are computed within a session first, then summarized
  across sessions. Never pool raw samples for the headline (ADR 0028 §1).
- **Derive before you capture.** Device attribution is a join over `session_start.device`, not a
  new client event (ADR 0028 §2).
- **Render-scale-honest.** Always carry `render_scale`/`dpr` next to an FPS number (ADR 0028 §4).
- **Distribution over mean.** Smoothness is the worst 1% of frames; lead with p95/jank, not avg.

---

## A. Query layer — `@uptimizr/db` (Phase A)

New builders in [`aggregations.ts`](../../oss/packages/db/src/query/aggregations.ts), each with a
ClickHouse + DuckDB dialect path and unit tests:

| Builder                    | Output                                                              | Notes                                                                                 |
| -------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `buildPerfDistribution`    | p05/p50/p95 FPS + histogram buckets                                 | Per-session percentiles in an inner aggregation, summarized across sessions.          |
| `buildFrameTimeP95`        | p50/p95/p99 frame-time (ms) + jank ceiling                          | Reads the promoted `frame_time_*` columns.                                            |
| `buildJankRate`            | `long_frames / samples` per session → median + worst-decile         | The "felt smoothness" headline.                                                       |
| `buildPerfByDevice`        | FPS p50/p95 grouped by `isMobile` / `engine` / `renderer`           | Session-descriptor CTE joins `frame_perf` rows to their `session_start.device` block. |
| `buildPerfByScene`         | FPS p50/p95 + jank grouped by `scene_id`                            | Reuses the promoted `scene_id` column.                                                |
| `buildResourcePercentiles` | p50/p95 of `js_heap_bytes`, `texture_bytes`, `triangles`            | From `resource_sample`.                                                               |
| `buildStabilityCounts`     | counts of `context_lost` + `compile_stall` (per session, per scene) | Already separate event types.                                                         |

Migration work (ADR 0007, forward-only, both engines): promote `frame_time_ms`,
`frame_time_p95_ms`, `long_frames`, `dpr`, `render_scale` to `events` columns; extend the
`toEventRow` mapper and the DuckDB appender to populate them. Historical rows read `0`/null until
re-ingested (no back-fill).

## B. Collector API — `collector-server` (Phase B)

Thin endpoints in [`query.ts`](../../oss/apps/collector-server/src/routes/query.ts), Zod-validated,
reusing the shared `RangeOptions` / `SessionOptions` / scene / source filters:

- `GET /api/v1/query/perf/distribution`
- `GET /api/v1/query/perf/frame-time`
- `GET /api/v1/query/perf/jank`
- `GET /api/v1/query/perf/by-device`
- `GET /api/v1/query/perf/by-scene`
- `GET /api/v1/query/perf/stability`
- `GET /api/v1/query/perf/resources`

## C. Dashboard — `PerformanceSection` (Phase C)

A new section wired through [`api.ts`](../../oss/apps/dashboard/src/lib/api.ts) and the global
filters, composed of sub-panels:

- **FPS distribution** — histogram + a p50/p95/p05 stat row (render-scale flag when < 1×).
- **Frame-time percentiles** — p50/p95/p99 ms.
- **Jank gauge** — long-frame rate.
- **FPS by device** — table grouped by device-class / engine / GPU renderer.
- **FPS by scene** — bars per `scene_id`.
- **Footprint** — memory / texture / triangle percentiles.
- **Stability** — context-loss + compile-stall counters.

## D. Docs

- [ADR 0028](../adr/0028-performance-analytics-and-percentile-aggregation.md) (done — this design's
  durable decisions).
- This design doc, referenced by each graduated issue (ADR 0016).

## Deferred / separate

- **Browser & OS breakdown** from a User-Agent parsed at ingestion (currently the UA is consumed
  only for the visitor hash in [`collect.ts`](../../oss/apps/collector-server/src/routes/collect.ts)
  and discarded). Needs a small privacy note: derived, non-PII, not stored raw. Tracked separately
  from the device/GPU breakdown, which ships first.

# ADR 0028: Performance analytics — per-session percentiles and device-aware FPS

- **Status:** Accepted
- **Date:** 2026-06-18
- **Deciders:** Uptimizr maintainers

## Context

Rendering performance is one of the most valuable signals a 3D-analytics product can offer:
"is my scene smooth, for whom, and where does it stall?" We already capture the raw material —
the [`frame_perf`](../../oss/packages/schema/src/events/framePerf.ts) event carries `fps`,
`frameTimeMs`, `frameTimeP95Ms`, `frameTimeP99Ms`, `longFrames` (jank), `drawCalls`, `dpr`, and
`renderScale`; [`session_start.device`](../../oss/packages/schema/src/events/sessionStart.ts)
carries the graphics backend, GPU `vendor`/`renderer`, `isMobile`, memory, and core count; and
`context_lost` / `compile_stall` / `resource_sample` capture stability and footprint.

Two problems motivated this ADR:

1. **The wrong aggregation was surfaced.** The dashboard's "Event volume over time" strip overlaid
   an `avg_fps` line on a wall-clock time axis. An FPS mean taken across whichever sessions happened
   to be online in a 30-minute bucket mixes devices and populations — it describes no real user and
   moves when the audience changes, not when performance does. The existing
   [`buildPerfSummary`](../../oss/packages/db/src/query/aggregations.ts) also pools all frame
   samples globally, so a single long "whale" session or a high-frame-rate device dominates the
   numbers.

2. **There is no performance section.** FPS, frame-time, jank, device breakdown, and stability are
   the metrics users ask for first, but they have no dedicated home in the dashboard.

We want a performance view that is honest about the **distribution** (smoothness lives in the worst
frames, not the mean), attributes performance to a **device**, and does not let session length or
sampling rate bias the headline numbers.

## Decision

1. **Per-session-then-aggregate percentiles.** Performance percentiles (p05/p50/p95 FPS,
   frame-time percentiles, jank rate) are computed **within each session first**, then summarized
   across sessions (median-of-medians style). One session = one experience; this prevents long
   sessions and high-frame-rate devices from dominating, matching the "per user experience" framing.
   The old pooled-sample `buildPerfSummary` is kept only as a coarse headline and is no longer the
   basis for distribution panels.

2. **Device attribution from existing session metadata — no SDK change.** FPS is segmented by the
   `session_start.device` block we already collect (`engine`, `isMobile`, GPU `renderer`/`vendor`)
   via a session-descriptor join, not by capturing anything new on the client. A coarser
   **browser/OS** breakdown derived from the User-Agent at ingestion is a deferred, separate
   follow-up (it needs a privacy note: derived, non-PII, not stored raw).

3. **Promote the jank/frame-time fields to columns (ADR 0007).** `frame_time_ms`,
   `frame_time_p95_ms`, `long_frames`, `dpr`, and `render_scale` graduate from the `payload` JSON
   to dedicated `events` columns via forward-only hand-written migrations, mirroring how `fps` is
   already promoted. This keeps the percentile/jank aggregations fast at ClickHouse scale and keeps
   the DuckDB OSS path consistent. The full event stays in `payload` (reads remain replay-complete).

4. **Render-scale-honest FPS.** Wherever FPS is reported, `render_scale` and `dpr` are available
   alongside it so the dashboard can flag an FPS number that was reached by rendering below native
   resolution (a "60 FPS at 0.5× scale" claim is not the same as 60 FPS at native).

5. **FPS is removed from the event-volume time-series.** Volume-over-time is event count only;
   performance lives exclusively in the new performance panels, framed per-session and per-device.

## Consequences

### Positive

- Headline performance numbers stop being skewed by session length, sampling rate, or audience mix.
- GPU/device-aware FPS ships with **zero client or schema change** — it is a query-layer join over
  data already on the wire.
- Promoted columns make the distribution/jank queries cheap and uniform across both storage engines.
- The dashboard gains a coherent performance story (distribution, frame-time, jank, device, scene,
  stability, footprint) instead of one misleading line.

### Negative / trade-offs

- Per-session-then-aggregate is more SQL than pooled percentiles (a nested aggregation / two passes).
- Column-promotion migrations are forward-only and must be written for both ClickHouse and DuckDB
  (ADR 0007); back-filling old rows from `payload` is out of scope — historical rows read `0`/null
  for the new columns until re-ingested.
- Browser/OS segmentation is deferred, so the first cut segments by device-class + GPU only.

## Alternatives considered

- **Pooled raw-sample percentiles** — simpler SQL, but biased toward long sessions and many-frame
  devices; rejected as the headline (kept only as a coarse summary).
- **`json_extract` on `payload` instead of promoting columns** — avoids a migration but is slower
  at ClickHouse scale and diverges from the existing `fps` promotion; rejected for the hot path.
- **Capturing the GPU renderer as a new per-session SDK event** — unnecessary; `session_start.device`
  already carries it. Rejected as redundant.
- **Keeping the FPS overlay on the volume chart** — rejected; a wall-clock mean across mixed devices
  is structurally misleading regardless of presentation.

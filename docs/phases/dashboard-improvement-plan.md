# Design sketch — dashboard improvement plan

> **Status:** Mutable design notes (not an ADR). A phased plan to take the OSS dashboard from a
> flat, all-time, 2D view to a filterable, time-aware analytics surface — including the **4th
> dimension, time**. Durable choices (if any) graduate to ADRs; everything here is UI/iteration.
> See [phase plans](./README.md). Not committed to a phase yet.

> **Implemented (Issue 2):** Phases A–D shipped. Global time-range + scene + input-source filters
> with debounced auto-refetch ([`GlobalFilters`](../../oss/apps/dashboard/src/components/GlobalFilters.tsx),
> [`lib/filters.ts`](../../oss/apps/dashboard/src/lib/filters.ts)); event-volume/FPS strip with
> brush-to-filter ([`VolumeTimeseries`](../../oss/apps/dashboard/src/components/VolumeTimeseries.tsx));
> per-session replay scrubber ([`SessionReplay`](../../oss/apps/dashboard/src/components/SessionReplay.tsx));
> 3D world-heatmap voxel viewer ([`WorldHeatmap3D`](../../oss/apps/dashboard/src/components/WorldHeatmap3D.tsx));
> and a scene-health panel ([`SceneHealth`](../../oss/apps/dashboard/src/components/SceneHealth.tsx)).
> Backend added three `@uptimizr/db` builders (`distinctScenes`, `timeseries`, `eventTypeCounts`)
> and routes `GET /api/v1/scenes`, `/timeseries`, `/event-counts`.

## Where the dashboard is today

The dashboard ([`oss/apps/dashboard`](../../oss/apps/dashboard)) talks to the collector query API
through [`lib/api.ts`](../../oss/apps/dashboard/src/lib/api.ts) and currently wires only:
`sessions`, `pointerHeatmap`, `cameraHeatmap`, `topMeshes`, `perf`, and `sessionMeta`. Every
panel is **project-wide, all-time, and 2D**.

### The gap is almost entirely frontend

The collector query layer ([`routes/query.ts`](../../oss/apps/collector-server/src/routes/query.ts))
already supports — and the dashboard already **ignores** — most of what the ADRs call for:

| Capability                        | Backend status                                         | Dashboard status       |
| --------------------------------- | ------------------------------------------------------ | ---------------------- |
| World/voxel 3D heatmap (ADR 0010) | `GET /api/v1/heatmaps/world` (`worldHeatmap`)          | **missing**            |
| Scene/area filter (ADR 0010)      | `scene` query param on heatmaps                        | **missing**            |
| Input-source filter (ADR 0011)    | `source` query param on pointer heatmap                | **missing**            |
| Single-session scoping            | `session` param on most aggregates                     | partial (detail)       |
| Time window                       | `since` / `until` on every range query                 | **missing** (all-time) |
| Per-session replay timeline       | `GET /api/v1/sessions/:id/events` + `@uptimizr/replay` | **missing**            |

So most of this plan is building UI on an **existing** query layer, with a few small backend
additions (a scenes-list endpoint and a time-series aggregate).

## The 4th dimension: time

A session is inherently 4D — 3D spatial interaction **over time**. The dashboard today collapses
time entirely (everything is all-time aggregates). Adding time has two complementary shapes:

1. **Filtering by time** — a global range picker (`since`/`until`) feeding every panel, plus brush
   selection on a volume histogram. This is what makes the perf/heatmap views trustworthy
   (an all-time average hides regressions).
2. **Replaying through time** — a per-session **timeline scrubber** that drives the existing
   deterministic, seekable `ReplayPlayer` in an embedded Babylon canvas. Scrub → camera, pointer
   markers, and mesh highlights move. This turns "replay" from a `<script>` snippet into a
   first-class dashboard feature.

## Phased plan

### Phase A — Filters & query controls (unlock the existing backend)

Lowest effort, immediate value; almost no backend work.

- **Time-range picker** wired to all panels (`since`/`until`). Presets (last hour / day / 7d) +
  custom. This alone fixes "all-time hides everything."
- **Scene selector** (ADR 0010). Needs a small new endpoint `GET /api/v1/scenes` returning distinct
  `scene_id`s (+ counts) for the project; wire `scene` into every heatmap call.
- **Input-source filter** (ADR 0011): mouse / touch / stylus / pen / xr-controller / hand / gaze /
  transient / other — wire `source` into the pointer heatmap.
- **Resolution controls**: `bins` (2D) and `cellSize` (world voxels).

**Backend delta:** one `GET /api/v1/scenes` route + a `distinctScenes` query builder in
`@uptimizr/db`.

### Phase B — The time dimension (headline)

- **Volume time-series** — a new `GET /api/v1/timeseries` (bucket events by interval, optionally by
  `type`) feeding an event-volume + FPS strip. Backend: a `timeseries` query builder bucketing on
  `ts`.
- **Brush-to-filter** — dragging a range on the strip sets the global `since`/`until`.
- **Per-session timeline scrubber** — embed a Babylon canvas + `@uptimizr/replay`'s `ReplayPlayer`
  (already seekable/deterministic) on the session detail view; fetch via the events endpoint
  (gated by retention). Play / pause / seek; markers for pointer/mesh/custom and (once Issue 1
  lands) error / context-loss / focus gaps on the track.
- **(Stretch) animated heatmap-over-time** — step the pointer/world heatmap through time buckets.

**Dependency:** the scrubber relies on raw-session retention (ADR 0003); show a "replayable" badge
(below) when it's off.

### Phase C — 3D world heatmap viewer (ADR 0010)

- Wire `worldHeatmap` into `lib/api.ts`; render voxels in a Babylon scene reusing replay's
  rendering surface (see [3d-heatmap-rendering-design](./3d-heatmap-rendering-design.md)).
- Apply scene + source + time filters from Phases A/B; color ramp + legend stating scope and max.
- Start with the dashboard-hosted viewer (Tier 0/4a overlay remains the SDK path).

### Phase D — Scene health & errors (depends on Issue 1)

- Surface the new lifecycle/error events from the
  [browser-events plan](./browser-events-capture-design.md): error rate, `context_lost` incidents,
  `viewport_resize` distribution, focus/visibility gaps, device/GPU breakdown — a "scene health"
  panel.

## Cross-cutting concerns

- **Replayability badge** — the Sessions table calls `/meta` (always available) vs `/events`
  (retention-gated); badge each session so it's obvious when replay/scrubbing is unavailable.
- **ClickHouse string coercion** — aggregate columns arrive as JSON strings and `null` fps on empty
  ranges; keep the `Number(... ?? 0)` coercion already used in `perf()` for every new aggregate.
- **Empty/loading/error states** per panel (the time-range picker makes empty windows common).
- **Export** — CSV/JSON download per panel (later).
- **Dashboard instructions** — follow
  [`dashboard.instructions.md`](../../.github/instructions/dashboard.instructions.md) (Next.js +
  Tailwind, server reads via API key only, never touch ClickHouse/Postgres directly).

## Backend additions summary (small)

| Endpoint                   | Purpose                                    | New `@uptimizr/db` builder |
| -------------------------- | ------------------------------------------ | -------------------------- |
| `GET /api/v1/scenes`       | distinct `scene_id`s (+counts) per project | `distinctScenes`           |
| `GET /api/v1/timeseries`   | event volume / FPS bucketed by interval    | `timeseries`               |
| `GET /api/v1/event-counts` | per-event-type counts (scene-health panel) | `eventTypeCounts`          |

Everything else (world heatmap, scene/source/session/time filters, session events) already exists.

## Suggested sequencing

A → B → C → D. Phase A unlocks value with near-zero backend work; Phase B is the 4th-dimension
headline and reuses the replay engine; C and D are larger and depend respectively on the heatmap
renderer and the Issue-1 events.

## Open questions

- Default time window on load — all-time, or last 24h? (Leaning last 24h to avoid the all-time
  trap, with an explicit "all time" preset.)
- World heatmap viewer first ship — dashboard-hosted (needs a scene proxy/asset) vs link out to the
  SDK overlay? (Leaning dashboard-hosted with a coarse bounds box when no asset is provided.)
- Should the timeline scrubber and the world heatmap share one embedded-Babylon component, or stay
  separate panels? (Leaning shared canvas host, different layers.)

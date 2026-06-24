# ADR 0037: Aggregate desire-line paths

- **Status:** Accepted
- **Date:** 2026-06-24
- **Deciders:** Uptimizr maintainers

## Context

The dashboard can already draw a **single** session's walked path: ADR 0026 added a per-session
`camera_sample` trajectory (`/api/v1/sessions/:id/trajectory`) rendered as one poly-line over the
floor plan. That answers "where did _this_ visitor go," but not the more useful product question:
"where does the _crowd_ go — which routes do visitors actually take, versus the ones the scene was
designed around?" That crowd-level picture is what urban planners call a **desire line**: the
informal path worn into the grass because it is the route people actually choose.

We want an aggregate, project-wide path view. The forces:

- **Volume.** Summed over every session, `camera_sample` is the highest-cardinality event in the
  store. Returning every raw position for every session would blow the response size and the
  client render budget on a busy project.
- **Replay-completeness is not required here.** Unlike a session replay, a desire-line overlay is a
  _density_ picture. Sub-cell jitter and exact timestamps do not matter; the shape of the common
  routes does.
- **Engine parity (ADR 0020).** Whatever query we author must render identically on DuckDB (OSS)
  and ClickHouse (scale tier), so it cannot lean on engine-specific path/window functions.
- **Privacy (ADR 0003).** The overlay must read as a crowd, never as a re-identifiable individual
  trail keyed to a person.

## Decision

Add an **aggregate desire-line** query and endpoint that returns every session's `camera_sample`
path **binned onto the X/Z ground grid** and **ordered**, keyed by `session_id`:

- New dialect-agnostic builder `buildAggregateTrajectories` (in `@uptimizr/db`) selecting
  `session_id`, `ts`, and the ground-bin indices `gx = floor(x / cellSize)`, `gz = floor(z /
cellSize)` from `camera_sample` events with a length-3 `position`, ordered by `session_id` then
  `ts`, capped by a `limit` volume guard. It accepts the standard range / scene / camera-mode
  filters.
- New read endpoint `GET /api/v1/paths` (scene + camera-mode filters, ground-bin `cellSize`, point
  `limit`), wired through both stores and the `@uptimizr/react` client as `aggregatePaths()`.
- A dashboard **Desire lines** panel (overview surface, gated to the first-person camera mode)
  that groups the points by `session_id`, **dedupes consecutive identical cells**, and draws one
  **low-opacity, additive poly-line per session** over an auto-fit floor plan. Overlapping routes
  self-reinforce into bright desire lines; sparse detours stay faint.

**Binning in SQL, drawing in the client.** The server bins (capping cardinality and removing
jitter) and orders the points; the client does the cheap per-session grouping, consecutive-cell
dedupe, and poly-line drawing. We deliberately do **not** pre-aggregate into a per-edge density
table in SQL — that would need window/`lag` functions (an engine-parity hazard) and would throw
away the per-session connectivity the overlay needs to draw continuous lines.

## Consequences

### Positive

- One project-wide query answers the crowd-routing question; the existing per-session trajectory
  remains for drilling into one visit.
- Binning + the `limit` cap bound the response size and client render cost on busy projects.
- The query is plain `floor`/`ORDER BY`/`LIMIT` — no window functions — so it renders identically
  on DuckDB and ClickHouse and is covered by a hand-verified golden in the parity suite.
- Additive low-opacity strokes turn overlap into density for free, with no server-side heatmap.

### Negative / trade-offs

- The overlay is point-ordered, not edge-deduplicated, so the heaviest projects still send one
  binned point per sample (bounded by `limit`). If that ceiling is ever hit, a future ADR can add a
  server-side edge-density rollup behind the same endpoint shape.
- `cellSize` is a fidelity/volume knob the operator must pick; too small re-introduces jitter, too
  large smears distinct routes together.

## Alternatives considered

- **Server-side edge-density rollup (count per `(from_cell → to_cell)` edge).** Rejected for v1: it
  needs `lag`/window functions to pair consecutive samples, which is exactly the engine-specific
  syntax ADR 0020 keeps out of the shared query layer, and it discards the per-session ordering the
  poly-line overlay draws from.
- **Return raw (unbinned) positions and bin in the client.** Rejected: highest-volume event in the
  store × every session would dominate the response and the parity golden would carry float
  positions instead of integer bins.
- **Reuse the single-session trajectory endpoint N times (one request per session).** Rejected:
  N round-trips per dashboard load, and no way to bound total volume.

# ADR 0040: Large-scene spatial resolution (bounds-driven binning, robust normalization, region drill-down)

- **Status:** Accepted
- **Date:** 2026-06-26
- **Deciders:** Project owner, engineering

## Context

[ADR 0010](./0010-spatial-3d-heatmaps.md) added the `scene_id` dimension and camera **pose**;
[ADR 0030](./0030-world-space-gaze-heatmap.md) added world-space gaze; [ADR 0014](./0014-scene-registry.md)
added the scene registry that stores per-scene **`bounds`** (AABB) and **`unitScale`**. Together these
make spatial heatmaps work well for a bounded scene roughly the size of its walkable area.

They do **not** hold up when a single scene is **much larger than its walkable/interactive area** —
e.g. a 10×-larger open world, a city block, or a long level with sparse points of interest. Every
spatial aggregation today bins with `floor(coord / cellSize)` against the **world origin** at a
**fixed absolute `cellSize`** (`buildWorldHeatmap` / `buildGazeHeatmap` default `0.5`; floor-plan,
coverage, and trajectory default `1`), then the world heatmap does `ORDER BY count DESC LIMIT 1000`,
and the 3D viewer colours/sizes each cell by `t = count / maxCount` (the single busiest cell) while
framing **one** bounding sphere over all voxels.

At ~10× scale this produces concrete failures:

1. **Truncation hides far areas.** `ORDER BY count DESC LIMIT 1000` returns only the busiest cluster.
   A distant region nobody reached is not shown as cold — it is simply **absent**, so "did anyone get
   to area X?" is unanswerable.
2. **Global max-normalization crushes contrast.** One spawn/doorway funnel becomes `maxCount`; a
   meaningful but quieter region far away renders as "few hits". Large scenes have a wide dynamic
   range, so most of the map reads dead.
3. **Fixed cell size is wrong at both ends.** `0.5 u` voxels over a 10× world explode distinct-cell
   cardinality (so the `LIMIT` bites harder); raising `cellSize` to span the world erases near-field
   detail. There is no single good fixed value.
4. **One framing, no navigation.** The viewer fits a single bounding sphere over everything, so
   clusters become sub-pixel. There is no region pan/zoom or sub-region re-bin.
5. **Origin-relative binning** loses float precision far from the origin (large coordinates are common
   in big worlds) and is not bounds-aligned.

The existing escape hatch is **manual `scene_id` segmentation**: the developer calls `setScene(...)`
at each area boundary (ADR 0010 §1). That is correct for **semantically distinct** areas (entry
screen vs. level 1 vs. level 5, or areas that **share coordinates** and must never be aggregated
together) — only the developer knows those boundaries. But forcing developers to chop **one
continuous large space** into arbitrary sections just to get a readable heatmap is a poor default: it
is manual work, the section seams are artificial, and density/coverage comparisons across seams break.

The key realization: **the large-scene problem is mostly a resolution / normalization / navigation
problem, not a segmentation problem.** The registry already stores the one fact needed to solve it
automatically — the scene `bounds`.

## Decision

Make large continuous scenes legible **automatically, within a single `scene_id`**, driven by the
registered scene `bounds`, and keep `setScene` as the explicit, optional boundary for semantically
distinct or coordinate-colliding areas. Concretely:

### 1. Bounds-driven default cell size (automatic, no new developer input)

- When a scene has registered `bounds` (ADR 0014), derive the default `cellSize` so the grid spans a
  roughly **constant number of cells across the longest axis** (a target resolution, e.g. ~64 cells),
  instead of a fixed absolute `0.5`/`1`. This keeps cell **count** — and therefore the meaning of the
  `LIMIT` and of normalization — stable regardless of world size.
- `cellSize` stays an **explicit override** on every spatial query (it already is); the bounds-driven
  value is only the default when the caller does not pass one. Scenes with no registered bounds keep
  today's fixed defaults (fully backward-compatible).
- This is a **query-default** decision, not a storage change: no migration, no new column, no SDK
  change. Binning math is unchanged; only the default divisor moves.

### 2. Robust, scope-stated normalization

- Replace single-cell max-normalization with a **robust scale** (a high percentile — e.g. p95/p99 —
  and/or a log scale) so a wide dynamic range no longer crushes the map to "dead". The legend MUST
  state the scheme and what the top of the scale represents (the renderer already exposes legend
  hooks; cf. ADR 0010 §1a, which already requires legends to state scope).
- Normalization is computed **within the queried scope** (range + scene + optional session + optional
  region, below), so zooming into a region re-normalizes to that region's own busy cell.

### 3. Make absence explicit (stop silently truncating)

- Alongside the busiest-`N` voxels, spatial heatmap responses SHOULD surface **totals** (distinct
  occupied cells, total hits) so the client can tell when the long tail was truncated.
- Add a **cold-spot / unreached** signal: cells or registered proxy areas with ~zero traffic relative
  to the reachable set, so "nobody went here" is **rendered**, not dropped. This reframes the big-scene
  question from density (which does not scale visually) toward **coverage** (which is the real
  question at 10×) and builds on the existing dead-zone report (ADR 0014 / `DeadZoneReport`).

### 4. Region (AABB) drill-down — semantic zoom

- Add an **optional axis-aligned bounding-box filter** to the spatial heatmap queries. The viewer
  shows a coarse, bounds-driven overview of the whole scene, then, on zoom into a sub-region,
  **re-bins that box at a finer `cellSize`** and re-normalizes to it. This is a `WHERE` clause plus a
  smaller divisor — the server already has the `hit_point` / `position` columns; no new storage.
- The region box is **viewer-chosen**, not developer-declared: it requires **zero** segmentation work
  and produces no artificial seams.

### 5. `setScene` remains the semantic-boundary tool, not a resolution workaround

- Document that `scene_id` (ADR 0010) is for areas that are **semantically separate** or **share
  coordinates** (so heat must never aggregate across them). It is **not** required to make one large
  continuous space readable — §1–§4 do that automatically. This removes the implicit pressure to
  over-segment.
- A corollary for backdrops: when a continuous space *does* self-declare sections (each tracked as its
  own `scene_id`), the connector registers a **scoped scene proxy per section** (ADR 0014) — each
  section's own geometry, not one whole-world proxy. So every area's world heatmap gets a correctly-
  framed backdrop (an elevated level shows just that level), and sections the visitor never entered
  still have a representation. The playground's `expanse` scene demonstrates this across all three
  connectors.

This ADR records the **durable** decisions (bounds-driven default resolution; robust, scope-local
normalization; an explicit region filter and absence/coverage signal; the semantic vs. resolution
split). Exact constants (target cell count, percentile, LOD instance caps) and rendering/LOD tactics
are **reversible** and live in the design sketch
([`docs/phases/3d-heatmap-rendering-design.md`](../phases/3d-heatmap-rendering-design.md)).

## Non-goals

- **Automatic semantic segmentation.** Auto-detecting "the kitchen" / "the boss arena" from data is
  out of scope and rejected below — it is unstable and needs developer hints `setScene` already
  provides.
- **A new event, column, or migration.** This is deliberately a query-default + query-param + viewer
  change. If coverage metrics later need a precomputed reachable-set rollup, that is a separate ADR
  (ADR 0007).
- **Server-side LOD storage / tiling.** Multi-resolution materialized tiles may come later; v1 re-bins
  on demand per region.

## Open questions

1. **Target resolution constant.** What cell-count-across-longest-axis gives a good overview without
   blowing the `LIMIT` (≈64? per-heatmap?), and should floor-plan (2D) and world/gaze (3D) target
   different counts given the cubic cell growth in 3D?
2. **Anisotropic bounds.** A long thin level (1000 × 20) makes longest-axis-driven cells coarse on the
   short axis. Per-axis cell sizing vs. a single divisor — does per-axis binning complicate
   normalization and the renderer?
3. **Normalization choice.** Fixed p95, configurable percentile, or log? It changes how hotspots read
   and must be legible in the legend across scopes (overview vs. region).
4. **Reachable-set denominator for coverage.** Coverage % needs a "could-have-been-visited" set. Derive
   it from proxy-mesh AABBs (ADR 0014), the scene bounds volume, or observed-cell convex hull? Each
   gives a different, defensible denominator.
5. **Region filter coordinate frame.** The AABB filter is in canonical world space (ADR 0018);
   confirm it composes with `unitScale` and the connector handedness normalization.
6. **Bounds drift / content versioning.** Bounds-driven `cellSize` shifts if the registered scene is
   re-laid-out; this inherits ADR 0010 §Open-Question-2 (scene-content versioning) — heat (and the
   chosen cell size) must not silently span a re-layout.

## Consequences

### Positive

- **Large continuous scenes become readable with zero developer effort** — adaptive cell size, robust
  normalization, and region drill-down all key off bounds the registry already stores.
- **No migration, no SDK change, no new event.** It is a query-default, a query parameter, a richer
  response, and viewer wiring — cheap and backward-compatible (scenes without bounds are unchanged).
- **Truncation stops lying:** totals + cold-spot/coverage signals make "unreached" visible instead of
  absent, answering the headline big-scene question ("what was explored / what was missed").
- **`setScene` is freed to mean what it should** — semantic / coordinate-colliding boundaries — rather
  than being abused as a resolution workaround, reducing over-segmentation.
- Reuses ADR 0014 bounds, ADR 0010/0030 query path and row shapes, and the existing 3D renderer and
  dead-zone report.

### Negative / trade-offs

- A bounds-driven default makes `cellSize` **scene-dependent**: the same absolute world distance maps
  to different cells in different scenes, so cross-scene density numbers are not directly comparable
  (mitigated: normalization is already per-scope, and the legend states the scale).
- Region re-binning issues an extra query per drill-down (more round-trips), and a robust percentile is
  a slightly heavier aggregation than a plain max.
- Coverage % depends on a chosen reachable-set denominator (Open Question 4); different denominators
  yield different headline numbers and must be documented.
- Anisotropic scenes still need either per-axis sizing or developer override; the single-divisor
  default is a compromise.

## Alternatives considered

- **Require manual `setScene` segmentation for large scenes (status quo).** Works, but pushes manual
  work onto developers, creates artificial seams, and breaks cross-seam density/coverage comparison.
  Rejected as the **default** for one continuous space; retained as the tool for semantically distinct
  or coordinate-colliding areas.
- **Automatic spatial clustering into sections** (k-means / density clustering of hits). Auto-detects
  regions, but clusters are **unstable across time ranges** (they move as data accumulates, breaking
  comparability) and impose hard borders on continuous space. Rejected.
- **A fixed uniform region-grid over the bounds** as "automatic sections". This is just adaptive cell
  size (§1) re-labelled as segmentation, with extra UI baggage. Folded into §1 instead.
- **Keep a single fixed `cellSize`, only fix normalization.** Helps contrast but leaves truncation and
  cell-cardinality explosion unsolved at 10×. Insufficient alone.
- **Server-side multi-resolution tiles up front.** Best zoom performance, but adds storage, a tiling
  scheme, and invalidation before the simpler on-demand re-bin is proven necessary. Deferred.
- **Raise / remove the `LIMIT`.** Returns the tail but floods the wire and the renderer with mostly
  empty far cells and still does not fix normalization or framing. Rejected in favour of
  bounds-driven resolution + explicit totals.

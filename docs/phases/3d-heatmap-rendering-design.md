# Design sketch — 3D heatmap rendering, viewers, and scene representation

> **Status:** Mutable design notes (not an ADR). The durable data-model decisions live in
> [ADR 0010](../adr/0010-spatial-3d-heatmaps.md); this document holds the **reversible** rendering,
> viewer, and scene-representation choices so they can evolve without superseding an ADR.
> Nothing here is committed for a specific phase yet — see [phase plans](./README.md).
>
> **Shipped so far:** Tier 0 live overlay (`@uptimizr/heatmap` — engine-agnostic core + Babylon
> adapter), Tier 1 data-only dashboard viewer (`WorldHeatmap3D`), Tier 2 proxy scan +
> **scene registry** (`scanSceneProxy` in `@uptimizr/babylon`, `sceneProxySchema` in
> `@uptimizr/schema`, Postgres `scene_representations`, and the dashboard backdrop), and a 3D
> **view-direction (gaze) dome** (`CameraDome3D`) plus heat legends on both 3D viewers. The proxy
> wire format and registry are now durable — see [ADR 0014](../adr/0014-scene-registry.md). Still
> open: Tier 3 full-asset registration, camera-occupancy heatmap, mesh-baked heat (v2), and the
> tracked viewer enhancements in [§7 Backlog](#7-backlog--tracked-viewer-improvements).

## Why this is separate from the ADR

ADR 0010 decides the things that are costly to reverse: the event-level `scene_id` dimension,
camera **pose** capture, and the generalized/per-session **scope**. How we _draw_ the data
(spheres vs mesh-baked heat), which **viewer** ships first, and how much **scene geometry** a
developer provides are UI/rendering concerns we expect to iterate on. Keeping them here avoids
churning an immutable record over a color-ramp or viewer tweak.

## 1. Rendering core (engine-agnostic + Babylon adapter)

- Mirror the `sdk-core` / `sdk-babylon` split: a framework-agnostic overlay core plus a Babylon
  adapter, living in (or beside) `@uptimizr/replay`. Reuses replay's **rendering surface** (it
  already draws into the user's own scene), **not** its per-session data path.
- **First technique:** instanced spheres / a thermal point cloud at voxel centers (a voxel's
  world center is `((v + 0.5) * cellSize)` per axis), colored by a normalized blue→red ramp
  (max = the busiest voxel, since results are `ORDER BY count DESC`). Works against any geometry
  with no UV/vertex access.
- **Deferred (v2):** baking heat onto the actual meshes — the most "real heatmap" look, but needs
  per-mesh UV access. Note: keying on `hitMesh` (mesh **name**) is fragile because names are
  often non-unique or auto-generated; a stable mesh identity (or UV-splatting by `hit_point`
  projection) is required first.

## 2. Viewers

- **4a — dev-integrated overlay (first):** the developer imports the overlay in _their own_ app
  and renders the heatmap for `(project, scene)` over their already-loaded scene. Most accurate,
  no asset hosting.
- **4b — dashboard-embedded viewer (later):** the dashboard embeds Babylon and loads a per-scene
  representation (proxy or asset) from the scene registry, then overlays the heatmap. The
  per-scene bounds also drive sensible default `cellSize` and camera framing.

A viewer exposes the **scope toggle / session picker** (generalized vs per-session, per ADR 0010
§1a). The color scale and legend must state which scope is shown and what the max represents,
since a single session's counts are far smaller than the aggregate. In the **generalized** scope,
per-session _paths_ are spaghetti — show density/occupancy, not polylines; reserve path polylines
for the per-session scope.

## 3. Camera-occupancy heatmap (separate, later)

"Where users stood/flew" (from `camera_sample.position`) is rendered as a **top-down density /
occupancy** on a floor plane or coarse grid — not a space-filling voxel cloud — and is a distinct,
later visualization from the surface/gaze heatmaps.

## 4. Scene representation — what the developer provides to see heatmaps

A 3D heatmap needs a **spatial frame to draw against**. We adopt a **tiered model** so value ships
with zero input and fidelity is opt-in. The data (`hit_point`, camera pose) is identical across
tiers — only the **context geometry** behind the heat differs.

- **Tier 0 — Live overlay (provide nothing).** The dev imports the overlay into _their own_
  running app; we draw heat directly in their scene's coordinate space. Highest fidelity, zero
  asset hosting, **zero IP egress**. This is viewer 4a and the recommended default. The heatmap
  coordinates already share the scene's coordinate system (`hit_point` was raycast in that scene).

- **Tier 1 — Data-only dashboard viewer (provide nothing).** The dashboard renders with **no
  scene**: thermal point cloud + (per-session) paths + an axis/grid and the scene **bounds box**
  for orientation. Always available, privacy-safe, no upload. Accumulated hits trace touched
  surfaces, so a recognizable silhouette often emerges. Answers _"where are the hotspots"_ but not
  always _"what object is that"_.

- **Tier 2 — Proxy scan ("scan mode", provide a structural proxy).** The SDK traverses the **live
  scene graph** (the Babylon adapter already holds the `Scene`) and emits a **compact structural
  proxy** rather than the real art: per-mesh **AABBs**, a **decimated convex hull / low-poly
  silhouette**, or an **occupancy voxelization**. KB-sized, keyed by `sceneId` + a **content
  hash/version**, re-emitted on scene change. The dashboard renders heat over this proxy — enough
  recognizable structure (floors, walls, big props) without shipping full geometry. Middle
  fidelity; low egress; recommended embedded-viewer default.

- **Tier 3 — Full asset registration (provide a real scene asset).** The dev explicitly registers
  a **glTF/`.glb`/`.babylon`** (ideally decimated) in the scene registry; the dashboard loads it
  under the heat. Highest dashboard fidelity, but highest storage cost, the **largest IP/security
  surface**, and can **drift** from the live scene — strictly opt-in.

**Is "scan mode" possible?** Yes. Within the dev's app the connector has a live reference to the
engine scene, so reading bounds, world matrices, and (optionally) decimated geometry is feasible
per engine. The real question is not _can we_ but _what is acceptable to send_ — hence the proxy
(Tier 2) is preferred over raw geometry (Tier 3), and both are opt-in. Scan logic is
engine-specific and lives in each connector (sdk-babylon first), producing one engine-agnostic
proxy format the viewer consumes.

## 5. Scene registry (Postgres)

Home for representation metadata per `sceneId`: `label`, `bounds`/AABB, up-axis + unit scale, a
**representation kind** (`none` | `proxy` | `asset`), the **proxy blob** or **asset URL**, and a
**content hash/version + capture timestamp** so the viewer can detect drift and the dev can
re-scan. Bounds/scale feed default `cellSize` and camera framing. Note: Tier 0/1 have **no
registry entry**, so a default `cellSize` has no units there — the overlay must take `cellSize`
from the host app (which knows its own scale) or expose it as a control.

## 6. Query surface (to keep endpoints from proliferating)

Heatmap types (pointer / camera-direction / world-surface / gaze / occupancy) should share **one
query contract** with common parameters — `scene`, optional `sessionId`, time range, `cellSize`,
`limit` — rather than five bespoke routes with divergent shapes. Decide the unified contract before
adding the next heatmap endpoint.

### 6.1 Large scenes (ADR 0040) — reversible tactics

[ADR 0040](../adr/0040-large-scene-spatial-resolution.md) makes a scene that is much larger than its
walkable area legible **automatically within one `scene_id`** (no forced `setScene` segmentation).
The durable decisions live in the ADR; the tunable tactics and constants live here and may evolve:

- **Bounds-driven default `cellSize`.** Derive the default from the registry AABB ([ADR 0014](../adr/0014-scene-registry.md))
  to target a roughly constant cell count across the longest axis (start ~64; revisit per heatmap,
  and note 3D cells grow cubically). Explicit `cellSize` always overrides; bounds-less scenes keep
  today's fixed defaults. Open: anisotropic (long-thin) scenes may want per-axis sizing.
- **Robust normalization.** Replace single-cell max with a high percentile (p95/p99) and/or log
  scale, computed within the queried scope; the legend states the scheme and what the top represents.
- **Explicit totals + cold-spots.** Return distinct-cell and total-hit counts alongside the busiest-N
  voxels so truncation is visible, and surface an unreached/coverage signal (builds on the dead-zone
  report) so "nobody went here" renders instead of being dropped by `LIMIT`.
- **Region (AABB) drill-down — semantic zoom.** An optional bounding-box query param re-bins a
  sub-region at finer `cellSize` and re-normalizes to it; the box is viewer-chosen, not
  developer-declared. Server-side multi-resolution tiles are deferred — v1 re-bins on demand.

## 7. Backlog — tracked viewer improvements

A single list of proposed, not-yet-built viewer enhancements so they live in one place. Ordered
roughly by effort. None of these require an event-schema change — they are all rendering/query work
on data we already capture (`pointer_click.hitPoint`/`hitMesh`, `camera_sample.position`/`direction`,
shared `sessionId` + timestamps).

> **Cross-panel mesh-name hover — shipped (#123).** Every 3D panel (`FlowSankey3D`, `ClickRays3D`,
> `WorldHeatmap3D`, `CameraDome3D`) shares one hover affordance: a panel tags the meshes it wants
> labelled (`mesh.metadata.hoverLabel`, or `hoverLabels[i]` for thin-instanced proxy boxes / dome
> markers) and calls `attachMeshHover(scene, canvas, setTip)` from `lib/sceneHover.ts`. On
> pointer-move it picks the scene, reads the label off the picked mesh/thin-instance, and shows a
> pointer-anchored HTML tooltip (rAF-throttled, one element, cleared on pointer-out). It only reads
> picks, so it never interferes with orbit/zoom. Flow nodes/ribbons and proxy boxes resolve to the
> mesh name; the direction dome (which has no mesh) names the look-direction bin + view count.

### 7.1 Sphere / point-cloud voxels (presentation polish)

> **Status: shipped.** `WorldHeatmap3D` now draws voxels as instanced low-segment
> **spheres** by default (so density reads as a soft thermal cloud), with a
> top-left **Spheres / Cubes** toggle that keeps cubes available for axis-aligned
> occupancy. Same per-instance matrices/colors; only the instanced base mesh
> changed.

`WorldHeatmap3D` previously drew each voxel as a thin-instanced **cube** (`CreateBox`). At a
distance the cubes read as hard blocks rather than a heat field. The marker is now an
instanced **sphere** (`CreateSphere`, low segment count) by default — so density reads as a
thermal cloud, matching §1's "first technique" intent — with cubes kept as a toggle option for
axis-aligned occupancy. Pure swap of the instanced base mesh; same matrices/colors.

### 7.2 Click ↔ gaze correlation: view-gated origin→hit rays ("A") — shipped

The insight: _the same mesh clicked from different viewpoints means different things._ For each
`pointer_click`, temporal-join to the nearest `camera_sample` in the same session to recover
"this mesh/point was clicked **while looking from here, in this direction**." (XR ray sources
already carry their own `origin`/`direction` via `inputSourceShape` — even more direct.)

Drawing one ray per click across all sessions is a hairball, so make rays **view-conditioned**:
bin click-time camera positions into the world/voxel grid and only draw rays whose origin falls in
the **currently focused region** (hovered voxel, or the region the orbit camera is nearest). Looking
from over here surfaces only the clicks made from over here. Cheap and directly answers "what does
a click mean _from this viewpoint_."

- **Query delta:** `clickGazeRayQuery` resolves each `pointer_click`'s ray origin source-agnostically
  (ADR 0011): pose-enabled sources (XR controllers, hands, gaze) carry their own world-space `ray`,
  so their `ray.origin` is used directly; flat pointers (mouse/touch/stylus) have no native ray and
  fall back to the nearest **preceding** `camera_sample` in the same session (an ASOF **left** join,
  so pose clicks survive sessions with no camera samples). Rays are aggregated by
  `(originVoxel, hitVoxel, mesh)` carrying the averaged origin/hit world points and a
  `count`. Exposed as `GET /api/v1/heatmaps/click-rays`.
- **Shipped form:** `ClickRays3D` draws each ray as a colored line (camera origin → hit), shaded by
  click volume, with a bright "eye" marker at each camera voxel. A **viewpoint** dropdown gates the
  scene to only the rays from one camera voxel.

### 7.3 Per-mesh incoming-direction rose ("C") — shipped

Select a mesh → render a small dome/fan at its centroid encoding the distribution of **viewing
directions** its clicks came from. Reuses the `CameraDome3D` marker code scoped to one mesh.
Answers "is this clicked mostly from the front, or also discovered from behind?" No lines crossing
the scene, so it composes well with 7.2. Shipped alongside 7.2 as the **Mesh rose** dropdown in
`ClickRays3D`: spokes radiate from the mesh centroid (proxy AABB center, or averaged hit point when
no proxy is registered) back toward the viewpoints its clicks came from, with spoke length/color
scaled by click volume.

### 7.4 Birdview timeline replay of origin + interaction (time dimension) — shipped

The heatmaps are deliberately **time-less** aggregates. This adds the missing 4th dimension as a
**replay**, not an aggregate: scrub a single session from a bird's-eye view and watch, per event,
the **camera origin/frustum** and the **interaction point** (`hitPoint`) appear/fade in step with
the playhead. This is the zero-clutter way to show 7.2's rays — only the events near the current
time are drawn, so nothing overlaps.

- Shipped in dashboard `SessionReplay`: driven by the existing seekable `ReplayPlayer` controls,
  rendered from a **birdview camera** preset, with a playhead-driven overlay that shows the current
  camera origin + forward vector and the **origin↔hit rays** fired near the current timestamp.
- Gating behavior remains ADR 0003-compliant: when raw-session retention is off (or no replayable
  events exist), the panel renders the existing "No replayable events" empty state.
- Includes a faint persistence trail (short fade window) so recently-fired rays linger for
  readability without turning into a full-session hairball.

### 7.5 Aggregate gaze→mesh flow ("B") — shipped (slices 1-3)

Instead of N discrete rays, bin `(camera-direction-bin → hitMesh)` pairs and draw a small number of
**thick arcs/ribbons** whose width = count — a directed "from gaze sector X, people clicked mesh Y"
graph (Sankey-in-3D). This is the no-timeline counterpart to §7.4: it preserves directional intent
while removing playhead/time controls. It stays readable at full-project scale where per-event rays
would turn into a hairball.

#### 7.5 shipped objective

Surface the dominant "where users looked from when clicking each mesh" flows in one static view,
without requiring replay/timeline interaction.

#### 7.5 shipped data contract (server)

- New aggregate query builder in `@uptimizr/db`:
  - Input: `since`, `until`, `scene?`, `session?`, `bins?` (default 24), `limit?` (default 150)
  - Join: `pointer_click` ASOF-joined to nearest preceding `camera_sample` in the same session
  - Group: `(azimuth_bin, elevation_bin, mesh)`
  - Output row:
    - `azimuth_bin: number`
    - `elevation_bin: number`
    - `mesh: string`
    - `count: number`

- Collector route:
  - `GET /api/v1/heatmaps/flow`
  - Query params: `bins`, `limit`, `scene`, `session`, `since`, `until`

- Dashboard API client:
  - `CollectorApi.flowHeatmap(params?) -> FlowLink[]`
  - `FlowLink = { azimuth_bin, elevation_bin, mesh, count }`

#### 7.5 shipped rendering contract (dashboard)

- New panel: `FlowSankey3D` (Babylon, client-only)
- Nodes:
  - Source node = camera-direction bin center on an abstract unit dome (reuse dome bin-to-direction mapping)
  - Target node = mesh centroid (proxy AABB center when available; fallback to averaged hit point if later added)
- Links:
  - 3D tube arc from source to target
  - Radius/color/alpha scale by normalized `count`
  - Render only top `N` links by count (`N` from `limit`) to preserve legibility

#### 7.5 shipped interaction

- Source and mesh focus selectors: highlight matching arcs/nodes only, dim others
- Small active-link status chip (`active/visible`) for filter feedback
- Legend with absolute count and normalized intensity
- Empty state: "No aggregate flow links for this filter"

#### 7.5 rollout slices (completed)

1. Data slice: query builder + store + route + API client + tests
2. Basic 3D view: arcs with width/color scaling, top-N cap, legend
3. Focus interactions: mesh/source filtering and emphasis states

#### Out of MVP (follow-ups)

- Full ribbon geometry with variable width along path
- Bidirectional bundling/edge routing optimization
- Animated transitions between filter changes
- Confidence/error bars per link
- **Position-aware source** (standpoint → gaze → mesh) for walkable/first-person scenes — see §7.8

**Delivered sequencing:** 7.1 (quick polish) → 7.2 + 7.3 together (view-gated correlation) →
7.4 (birdview timeline replay) → 7.5 (aggregate flow).

### 7.6 Gaze heatmap as a Tier 0 in-scene overlay

> **Status: shipped (marker + skydome).** `@uptimizr/heatmap` renders the gaze
> distribution into the developer's own scene in two forms. Core:
> `buildGazeInstances(data, style)` (markers) and `buildGazeEquirect(data, options)`
> (continuous texture).
>
> - `GazeOverlay` (engine-free) beside `buildHeatmapInstances`/`HeatmapOverlay`;
>   fetch via `fetchGazeHeatmap` (`GET /api/v1/heatmaps/camera`, no schema change);
>   Babylon one-call helpers `showGazeDome({ scene, …, followCamera })` (markers) and
>   `showGazeSkydome({ scene, …, followCamera })` (equirectangular skydome), both
>   centered on a live camera. The dashboard `CameraDome3D` panel exposes the same
>   **Markers / Skydome** toggle.

Today the gaze visualization (`CameraDome3D`) is **dashboard-only**. The same data can render in the
developer's **own running scene** as a Tier 0 overlay — the engine-agnostic `@uptimizr/heatmap`
core already does this for world voxels, so gaze is a second overlay mode (`buildGazeInstances`
beside `buildHeatmapInstances`), with a Babylon adapter. Two host-side forms:

- **Markers on a dome (shipped)** — reuse the dome reconstruction (azimuth/elevation bin → unit
  direction) and place instanced markers on a large sphere **centered on the live camera**, so the
  developer literally stands inside the gaze distribution. Cheap; reuses the spherical bins as-is.
- **Equirectangular skydome (shipped)** — `buildGazeEquirect` splats the bins into an equirectangular
  heat texture (angular-Gaussian, engine-free) which `showGazeSkydome` maps onto an inward-facing
  dome with a smooth thermal ramp. The polished, continuous version; especially natural in WebXR
  ("look around and see what others looked at").

Both reuse the existing camera-direction query (no schema change) and share the `§6` unified
contract. Tier 1 (dashboard dome) stays for people who don't embed the overlay.

> **Canvas interaction fix (shipped):** the embedded dashboard canvases previously bound the mouse
> wheel to Babylon's orbit-zoom, which hijacked page scrolling. Wheel-zoom is now removed
> (`disableWheelZoom`) in favor of explicit +/- `ZoomButtons`, so the page scrolls normally over a
> canvas — see [`lib/orbitZoom.ts`](../../oss/apps/dashboard/src/lib/orbitZoom.ts).

### 7.8 Position-aware flow ("B+"): standpoint → gaze → mesh for walkable scenes

> **Status: slices 1–4 shipped — OSS / Phase 1.** Extends the shipped §7.5 Flow
> Sankey. **No event schema
> change** — reuses `camera_sample.position`/`direction` and `pointer_click` exactly as today, plus
> the world-voxel grid of [ADR 0010](../adr/0010-spatial-3d-heatmaps.md) and the camera-mode
> dimension of [ADR 0026](../adr/0026-camera-mode-aware-analytics.md).

#### 7.8 motivation

§7.5 bins each click by the camera's **direction only** (`atan2(dz,dx)`, `asin(dy/|d|)`); the
click-time **position** recovered by the ASOF join is discarded. That is faithful for
**position-stable** scenes (orbit / turntable / fixed-vantage product viewers), where direction ≈
the full pose. In a **first-person walkable** scene the same world heading occurs from many
unrelated standpoints (the entrance, a far corridor, inside a room), so a single "direction → mesh"
ribbon silently merges spatially distinct situations and the directional intent becomes ambiguous.

The data already distinguishes these cases — only the visualization collapses them. §7.8 restores
**position as a first-class source dimension** so the Sankey answers the question that actually
matters in a walkable space: **"standing _where_, and looking _which way_, did people click mesh
_Y_?"** It is the de-cluttered, no-timeline aggregate counterpart to §7.2 `ClickRays3D` (which
preserves position but draws discrete rays) and §7.4 birdview replay (which preserves position but
needs a playhead).

#### 7.8 objective

Surface the dominant **standpoint → gaze-sector → clicked-mesh** flows in one static view, keeping
the per-standpoint dome readable instead of fusing every standpoint into one abstract dome, while
holding total link count bounded (no hairball).

#### 7.8 legibility / cardinality strategy

A naive `(positionVoxel × directionBin × mesh)` cross-product re-introduces the clutter the Sankey
exists to avoid. Two complementary controls keep it legible:

1. **Standpoint gating (default, cheapest).** The position axis is a _filter_, not extra geometry:
   pick / hover one **standpoint voxel** and render the familiar §7.5 direction-dome → mesh Sankey
   scoped to clicks made from that voxel. Identical render code to §7.5; one voxel at a time, so
   link count stays ≈ §7.5. Mirrors the §7.2 viewpoint dropdown.
2. **Two-stage Sankey (the powerful form).** A genuine three-column flow
   `standpoint → gaze sector → mesh`: top-`P` standpoints by volume on the left, each with its own
   compact gaze fan, ribboned to the meshes they clicked. Cardinality is bounded by capping `P`
   standpoints and top-`N` links overall, with a "merge tail into _other_" bucket.

Standpoint count is further tamed by (a) a coarser `cellSize` for the origin grid than for the hit
grid, and (b) an optional follow-up **standpoint clustering** pass (grid-merge / k-means over
click-time positions) so the left column is a handful of semantic vantage points rather than raw
voxels.

#### 7.8 camera-mode awareness (ADR 0026)

The panel is **most valuable in walk/first-person mode and least necessary in orbit mode**, so it
consumes the camera-mode dimension:

- A **camera-mode filter** (`mode=walk|orbit|…`) scopes the aggregate, reusing the existing
  `CameraModeOptions` already threaded through `buildPointerWorldHeatmap` / `buildClickGazeRay`.
- The dashboard **defaults this panel to `walk`** when the active range has first-person camera
  samples, and shows a hint ("position adds little in orbit scenes — see the View dome / §7.5")
  when the active data is orbit-dominated. This makes the viewer-vs-walkable distinction an explicit
  product affordance rather than a silent caveat. **(shipped)** `FlowSankey3D` owns the camera-mode
  dimension: a **Walk | Orbit | All** segmented control re-issues the flow query per mode via its
  own `CollectorApi` call (the page hands it the resolved base query + a first-person signal derived
  from the first-person floor-plan having samples). It defaults to **Walk** on first-person scenes
  (once, so an explicit choice sticks) and renders the orbit-dominated hint when no first-person
  samples exist.

#### 7.8 data contract (server)

Extend `buildFlowHeatmap` in [`@uptimizr/db`](../../oss/packages/db/src/query/aggregations.ts)
rather than adding a parallel builder, so the direction-binning and ASOF join stay single-sourced.

- New options (all optional; omitting them reproduces today's direction-only rows byte-for-byte):
  - `cellSize?: number` — origin voxel edge for the **standpoint** grid (default `0.5`, matching
    `buildClickGazeRay`).
  - `originVoxel?: [vx, vy, vz]` — when present, **filter** to clicks whose standpoint falls in that
    voxel (standpoint-gating mode).
  - `groupByOrigin?: boolean` — when `true`, add the standpoint voxel to the `GROUP BY` (two-stage
    mode); when `false`/absent, behave as §7.5.
  - `CameraModeOptions` (`mode?`) — camera-mode filter, identical clause to the other voxel queries.
- **Origin resolution (ADR 0011, source-agnostic).** Reuse the `buildClickGazeRay` pattern: prefer
  the click's own `ray_origin` when the input source carries a pose (XR controllers / hands / gaze),
  else fall back to the ASOF-nearest preceding `camera_sample.position`. This makes XR teleport-walk
  and flat-pointer walk behave consistently.
- Output row (superset of the §7.5 `FlowLink`; new fields only emitted in origin modes):
  - `azimuth_bin: number`
  - `elevation_bin: number`
  - `mesh: string`
  - `count: number`
  - `origin_vx, origin_vy, origin_vz: number` — standpoint voxel indices
  - `origin_x, origin_y, origin_z: number` — averaged standpoint world point (for placing the
    left-column node / minimap marker)
- Collector route: extend `GET /api/v1/heatmaps/flow` with `cellSize`, `mode`, `groupByOrigin`, and
  `originVoxel` (`vx,vy,vz`). Backward compatible — existing callers get unchanged output.
- Dashboard API client: widen `CollectorApi.flowHeatmap(params?)`; `FlowLink` gains the optional
  `origin*` fields. Existing consumers ignore them.

#### 7.8 rendering contract (dashboard)

Evolve `FlowSankey3D` (or a sibling `FlowSankeyByStandpoint3D`) — reuse its Babylon scene, `heatRgb`
ramp, bezier tubes, dome bin→direction mapping, and `ZoomButtons`:

- **Standpoint-gating mode (slice 1, shipped):** add a **Standpoint** selector (dropdown of top
  voxels). Selecting one renders the existing §7.5 dome→mesh Sankey filtered to that standpoint,
  with a pin marker showing where that vantage sits in the scene (averaged `origin_*`). "All
  standpoints" reproduces today's view. (Click-to-pick from a birdview minimap is folded into the
  slice-3 two-stage view.)
- **Two-stage mode (slice 3, shipped):** a **Aggregate | Two-stage** toggle switches the panel to
  three node columns — standpoint nodes on a left rail, gaze-sector nodes on each standpoint's
  compact fan, and mesh nodes on a right rail — with tube width/color = normalized `count`. Top-`P`
  standpoints and top-`M` meshes are kept; the tail folds into `other` nodes and the top-`N` ribbon
  cap re-routes its tail to the standpoint's `other` mesh.
- A small **birdview minimap** inset (shipped) plots the standpoint voxels over the proxy-mesh
  footprints so the left column reads spatially; clicking a dot picks that standpoint.

#### 7.8 interaction

- Standpoint, gaze-sector, and mesh focus selectors (extends §7.5's two-way focus to three stages):
  selecting any node highlights only the ribbons threading it, dims the rest.
- Camera-mode toggle (`walk` / `orbit` / `all`) with the orbit-dominated hint above.
- Active-link status chip (`active/visible`) and the existing count + normalized-intensity legend.
- Empty states: "No aggregate flow links for this filter" and, when only orbit data exists, the
  "position adds little in orbit scenes" hint that links back to §7.5 / the View dome.

#### 7.8 rollout slices

1. **Data slice:** extend `buildFlowHeatmap` (origin voxel grouping, `originVoxel` filter,
   `groupByOrigin`, camera-mode, ADR 0011 origin resolution) + route + API client + parity/unit
   tests (mirror the existing `flowHeatmap` parity case with an origin-grouped variant). **(shipped)**
2. **Standpoint-gating UI:** Standpoint selector + scene pin marker; reuses §7.5 rendering.
   **(shipped)**
3. **Two-stage Sankey:** three-column flow with top-`P`/top-`N` caps and `other` bucket; birdview
   minimap inset. **(shipped)**
4. **Camera-mode defaulting + hints:** auto-default to `walk`, orbit-dominated hint. **(shipped)**

#### 7.8 out of MVP (follow-ups)

- Standpoint **clustering** (grid-merge / k-means) for a semantic left column instead of raw voxels.
- Edge bundling / routing between the three columns to reduce ribbon crossings.
- Per-standpoint **dwell weighting** (weight links by time spent at the standpoint, not just click
  count) once occupancy (§ ground-plane) is joined in.
- Animated transitions between standpoint selections.

#### 7.8 privacy & boundaries

Pure aggregate over existing events — ADR 0003 compliant (no raw-session dependency, no new PII, no
client persistent IDs). Standpoint voxels are coarse spatial bins, not trajectories. All work lands
in `oss/**` (`@uptimizr/db`, collector route, dashboard); storage stays behind the `@uptimizr/db`
contracts ([ADR 0004](../adr/0004-monorepo-separation.md)). Per AGENTS.md golden rule 8, shipping this updates
the public docs site and `docs/integration.md` (the `/api/v1/heatmaps/flow` reference) in the same
change.

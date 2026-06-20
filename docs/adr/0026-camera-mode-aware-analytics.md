# ADR 0026: Camera-mode-aware analytics — viewer vs. first-person scenes

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** RaananW, engineering

## Context

3D analytics serve two structurally different audiences, distinguished by **how the camera moves**:

1. **Viewer scenes** — an orbit / arc-rotate camera framing a single model or product. The visitor
   stays "outside looking in." The analytical questions are about the _object_: which angles are
   looked at, is the model interesting, where do people click on it.
2. **First-person / walkable scenes** — a free camera the visitor _traverses_ (WASD, pointer-lock,
   XR locomotion) through a larger environment with walls, rooms, and items. The visitor is "inside
   looking around." The analytical questions are about the _space_: where do people walk, where do
   they stand and dwell, which route did they take, which areas are dead zones.

The capture layer already records the distinction. `session_start` carries a `scene.cameraType`
([ADR 0021](./0021-graphics-backend-and-engine-diagnostics.md) / the scene-metrics work), and the
Babylon connector auto-classifies Babylon's `ArcRotateCamera` as `"arc-rotate"` and
`UniversalCamera` as `"free"`. So `cameraType` is **already a first-class, stored field** — but
nothing downstream used it: it could not be filtered on, and there was no panel that read
first-person spatial behavior (standing positions, walked paths). The data existed; the product
did not surface it.

### Forces

- **The signal already exists — don't reinvent it.** `cameraType` is captured and stored. The work
  is to _use_ it (filter + new spatial reads), not to add a new event. Adding a redundant
  "scene mode" event would violate "events live once" ([AGENTS.md](../../AGENTS.md)).
- **Viewer vs. first-person is a coarse product toggle, not a raw enum.** A dashboard user thinks
  "show me the walkable sessions," not "show me `cameraType = free`." The dashboard exposes a
  two-value **camera-mode** toggle (`viewer` / `first-person`); the collector translates it to the
  stored `cameraType` (`arc-rotate` / `free`) at the query boundary. Keeping the raw value out of
  the UI lets the stored vocabulary grow (e.g. `follow`, `cinematic`) without reshaping the toggle.
- **First-person needs its own spatial panels.** The existing pointer/world heatmaps answer
  "where on the object." A walkable scene needs the **floor-plan** question ("where do people
  stand") and the **trajectory** question ("what route did they take") — both read from the same
  `camera_sample` position stream ([ADR 0012](./0012-sampling-and-fidelity.md)), projected onto the
  X/Z ground plane.
- **Not every connector can self-classify.** Babylon's camera classes map cleanly to
  `arc-rotate` / `free`. three.js and PlayCanvas use generic perspective cameras plus a separate
  controls object, so the connector cannot infer orbit-vs-free from the camera alone. The
  application that wires up the controls knows the mode, so the connectors must accept an explicit
  override rather than guess.
- **Open-core boundary** ([ADR 0020](./0020-open-core-storage-boundary.md)): the camera-mode filter
  and the floor-plan / trajectory aggregations are plain SQL over the existing event store. They
  render through the dialect abstraction and run identically on DuckDB (OSS) and ClickHouse
  (hosted), so they belong in OSS.

## Decision

Make `cameraType` an **actionable analytics dimension** and add the two spatial aggregations a
first-person scene needs. No new event type.

### 1. Camera-mode filter (collector + dashboard)

- The collector query API accepts an optional `cameraMode` parameter (`viewer | first-person`) on
  the session list and the pointer / world / camera-direction / floor-plan endpoints. It is
  translated to the stored `cameraType` (`viewer → arc-rotate`, `first-person → free`) and applied
  as a session-scoped predicate: an aggregate is restricted to sessions whose `session_start`
  recorded that `cameraType`. Omitting `cameraMode` includes all sessions (unchanged behavior).
- The dashboard's global filter bar gains a **Camera mode** selector (`All cameras` / `Viewer
(orbit)` / `First-person (walk)`) alongside scene and input-source, threaded through every panel
  request.

### 2. Two new aggregations (`@uptimizr/db`)

Both read `camera_sample` positions and render through the `Dialect` abstraction, so they are
DuckDB/ClickHouse-agnostic and covered by the SQL parity suite.

- **`buildCameraPositionHeatmap`** — the top-down "floor plan." Bins camera world positions onto
  the X/Z ground plane at a `cellSize` (default 1 world unit), returning occupied cells
  `(gx, gz, avg_y, count)`. The first-person analog of the 2D pointer heatmap: _where visitors
  stand and dwell_.
- **`buildSessionTrajectory`** — one session's ordered walked path: `camera_sample` positions for a
  single `sessionId`, oldest first, as `(ts, x, y, z)`. The route the visitor took.

Exposed by the collector as `GET /api/v1/heatmaps/position` and
`GET /api/v1/sessions/:sessionId/trajectory`.

### 3. Connector camera-type override (three / PlayCanvas)

The three.js and PlayCanvas connectors' `trackScene` accept an optional `cameraType` so an
application can declare `"free"` (walkable) or `"arc-rotate"` (viewer) when the camera class is
ambiguous. Babylon continues to auto-classify and needs no override.

### 4. Dashboard panels

- **Floor-plan heatmap** (overview grid) — renders `buildCameraPositionHeatmap`, auto-fitting the
  occupied bounding box, intensity = dwell count. Because a camera _position_ is only a "standing
  location" for a free camera — an arc-rotate camera's position orbits the model — this panel is
  **always scoped to first-person** (`cameraType: "free"`) regardless of the global camera-mode
  toggle, and is hidden when the toggle is set to `viewer`. This prevents viewer orbit positions
  from polluting the "where visitors stand" map.
- **Walked path** (session drill-down) — renders `buildSessionTrajectory` as a connected top-down
  polyline with start/end markers. Shown only for first-person sessions (the session's recorded
  `cameraType` is `free`); a viewer session's "path" is just its orbit and is omitted.

### 5. Playground walkable scenes

The example playground gains a **camera-mode toggle** (`?camera=` URL param + persisted) that, for
capable engines (Babylon, three, PlayCanvas), swaps the orbit demo for a **walkable scene**: a
room with walls, item pedestals, an ambient NPC, and a WASD / pointer-lock first-person camera.
This generates real `cameraType: "free"` sessions to exercise the new analytics end-to-end.

To also demonstrate **per-experience project separation**, `pnpm db:seed` provisions _two_ demo
projects — a viewer (arc-rotate) project and a walkable (first-person) project — and the playground
sends each camera mode to its own project (`VITE_PROJECT_ID` / `VITE_PROJECT_ID_WALKABLE`). Both are
written to the local dashboard registry so the project picker lists them. This is a presentation
choice for the demo, _not_ a contradiction of the dimension model: the camera-mode filter still
applies within a single project for real apps that legitimately mix both camera styles. (The e2e
harness leaves the walkable project unset, so both modes share one project there and exercise the
camera-mode _filter_ path.)

## Consequences

- **Positive:** `cameraType` becomes a usable dimension; first-person scenes get spatial reads
  (standing positions, routes) they previously lacked; the viewer narrative is unchanged. The
  three/PlayCanvas viewer scenes are also now correctly labelled `arc-rotate` instead of defaulting
  to `free`.
- **Neutral:** Two aggregations added (28 → 30); the SQL parity suite and its "covers all N"
  assertion grow accordingly. The `cameraMode` predicate is a no-op when unset, so all existing
  queries and parity goldens render identically.
- **Cost:** The floor-plan and trajectory aggregations scan `camera_sample`, the highest-volume
  event type. Both are bounded (cell `LIMIT`, trajectory point `LIMIT`) and respect the time
  range, so cost is comparable to the existing world heatmap.
- **Future:** A stored `cameraType` beyond `arc-rotate` / `free` (e.g. `follow`) would extend the
  dashboard toggle without reshaping the storage or the translation seam.

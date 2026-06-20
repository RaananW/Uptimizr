# ADR 0010: Spatial (3D) heatmaps, scene/area dimension, and camera pose

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** Project owner, engineering

## Context

Uptimizr ships two heatmaps today, both rendered as flat 2D canvases in the dashboard:

- **2D pointer heatmap** — bins screen-normalized pointer positions (`pointer_move` +
  `pointer_click`). Inherently screen-space.
- **View-direction heatmap** — bins camera **forward** vectors by spherical angle onto an
  abstract sphere. Direction-only, scene-independent.

Pointer events already carry an optional **world-space raycast hit** (`hitPoint`/`hit_point`)
and the **hit mesh name** (`hitMesh`/`mesh`), and a first **world-space (3D) pointer heatmap**
aggregation now exists — `worldHeatmapQuery` voxel-bins `hit_point` into a uniform grid, exposed
as `GET /api/v1/heatmaps/world` (commit `0b68f11`). What does **not** exist yet is any way to
**render** that data in 3D, or to make it meaningful across non-trivial scenes.

Two structural problems surface as soon as we go beyond the current simple arc-rotate demo:

1. **There is no "where" dimension.** The spatial model is `project → session → events`. `scene`
   is only a _per-session descriptor_ on `session_start` (camera kind, mesh count, free-text
   description). Individual events carry no level/area identifier. A project may track many
   distinct areas — e.g. a game with an entry screen plus 10 levels — and a single session can
   move through several of them (entry → L1 → L2). Voxel-binning `hit_point` across the whole
   project collapses Level 1's `(0,0,0)` and Level 5's `(0,0,0)` into the same cell, making a
   project-wide 3D heatmap meaningless.

2. **Unbounded worlds.** An arc-rotate scene is bounded; a `FreeCamera`/WebXR world can be
   effectively infinite. The **surface/hit heatmap** is still bounded in practice (it only exists
   where rays hit geometry, and is capped by `limit`), but a **camera-occupancy heatmap** (where
   users physically stood/flew) can spread without bound and should not be drawn as a space-filling
   voxel cloud.

Finally, position alone undersells the most valuable spatial signal. What matters — especially in
**WebXR** — is the full **camera transformation: position _and_ orientation** (where the user is
**and** what they are looking at). Gaze/attention in world space is high-value data that the
view-direction sphere (orientation without position) and an occupancy map (position without
orientation) each only half-capture.

## Decision

This ADR records only the **durable, hard-to-reverse** decisions: the spatial data model. The
**reversible** rendering, viewer, and scene-representation choices live in a mutable design sketch
([`docs/phases/3d-heatmap-rendering-design.md`](../phases/3d-heatmap-rendering-design.md)) so they
can evolve without superseding an ADR. 3D heatmaps reuse the **rendering surface** of session
replay (drawing into the framework user's own scene), **not** replay's per-session data path —
heatmaps come from aggregate queries.

### 1. Add a scene/area dimension to the event model (keystone)

- Introduce a stable, developer-assigned **`sceneId`** (e.g. `"lobby"`, `"level-3"`). It is an
  **event-level** dimension, not a session-level one, because a session can span multiple areas.
- The SDK exposes **`setScene(sceneId)`**; the host app calls it on area/level load. The SDK
  stamps a low-cardinality `scene_id` onto every subsequent spatial event and emits a small
  **`scene_change`** marker event so the replay timeline stays ordered and complete.
- ClickHouse gains a denormalized **`scene_id`** column; ingestion stamps it; spatial heatmap
  queries gain a `scene` filter and `GROUP BY scene_id`. Default is `"default"`, so existing
  single-area projects keep working unchanged (backward-compatible).
- This is preferred over deriving the active scene at query time from `scene_change` events alone,
  which would force a windowed join on every heatmap query.

### 1a. Two scopes: generalized (aggregate) and per-session

Every 3D heatmap exists at **two scopes**, sharing one query path, one aggregation, and one
renderer — they differ only by an optional `sessionId` filter:

- **Generalized (default).** Accumulate across **all sessions** in `(project, scene, time-range)`
  — "where does the whole audience look / click." This is what the current heatmap queries already
  produce (they aggregate over every session).
- **Per-session.** The same voxel/surface accumulation scoped to a **single `sessionId`** — "where
  did _this_ user look / click," shown as a static heat summary of one visit. This is **distinct
  from replay** (ADR 0006): replay re-drives the ordered timeline of one session; a per-session
  heatmap is the time-collapsed spatial density of that same session. They are complementary —
  replay answers _"what happened, in order"_; the per-session heatmap answers _"what did this one
  user attend to, overall."_

Implementation is intentionally cheap: the spatial queries gain an **optional `sessionId`**
parameter (absent = generalized, present = that session); normalization (the blue→red max) is
computed within the chosen scope. The viewer (§4) exposes a scope toggle / session picker; the
color scale and legend must state which scope and what the max represents, since a single session's
counts are far smaller than the aggregate.

### 2. Capture camera **pose**, not just position

- The spatial signal of record is the **camera transformation**: position **and** orientation.
  `camera_sample` already carries `position` + `direction` (+ optional `target`, `fov`); these are
  sufficient to reconstruct a world-space gaze ray per sample. We will treat **world-space gaze**
  (raycast of pose into the scene, accumulated on surfaces — "what did people actually look at")
  as a first-class 3D heatmap, distinct from the existing abstract direction sphere.
- This is the headline value for **WebXR**, where head pose is a usable proxy for attention.
  Orientation must never be dropped in favor of position-only aggregation. (Head-forward is a
  _proxy_ for gaze, not eye-tracked gaze — see Open Questions.)

## Non-goals (for this ADR)

These are real and planned, but are **rendering/UI/representation** concerns captured in the
mutable [design sketch](../phases/3d-heatmap-rendering-design.md), not durable data-model
decisions:

- **Render technique** — instanced spheres / point cloud first; mesh-baked heat deferred to v2.
- **Viewers** — dev-integrated overlay (4a) first, dashboard-hosted viewer (4b) later.
- **Camera-occupancy heatmap** — top-down density, a separate later visualization.
- **Scene representation tiers & scan mode** — the Tier 0–3 model (live overlay → data-only →
  proxy scan → full asset) and the **scene registry** (Postgres) that stores per-scene bounds,
  scale, representation kind, and proxy/asset.
- **Unified heatmap query contract** — sharing `scene` / `sessionId` / `cellSize` params across
  heatmap endpoints instead of bespoke routes.

## Open questions (must be resolved before/early in implementation)

1. **Gaze raycast — client or server? (gates the schema, decide first.)** **Resolved by
   [ADR 0030](./0030-world-space-gaze-heatmap.md):** do **both** — always store raw pose; add an
   **optional, opt-in, throttled** client-side gaze `hitPoint`/`hitMesh` on `camera_sample` (off by
   default, riding the existing camera cadence). "World-space gaze" requires raycasting camera pose
   into geometry, but the server has **no geometry**. Either (a) the SDK raycasts each sampled pose
   **client-side** and emits a `hitPoint` like pointers do (costs CPU at WebXR frame rates — needs a
   sampling budget), or (b) we store **raw pose** and only viewers that _have_ the scene (Tier 0)
   resolve surface hits at render time (data-only viewer then cannot show surface gaze). The
   throttling/opt-in budget for this is governed by [ADR 0012](./0012-sampling-and-fidelity.md).
2. **Scene content versioning.** `hit_point`/pose are in the scene's world space. If the dev
   re-centers or re-lays-out a level, the same coordinates are no longer the same physical spot,
   so heat must not be aggregated across that boundary. Aggregation likely needs to bucket on a
   **scene content version/hash**, not `scene_id` alone. How is that version derived and supplied?
3. **`scene_id` guardrails & PII.** `scene_id` is developer-supplied free text. Enforce
   charset/length limits and a **cardinality cap** (defined behavior on breach) to protect
   `LowCardinality`/partitioning, and contractually forbid PII / per-user / per-load values
   (ADR 0003).
4. **Migration & rollups (ADR 0007).** Adding `scene_id` to the existing `events` table needs a
   `DEFAULT`/backfill story for existing rows, and the **0003–0006 rollups/materialized views**
   must carry `scene_id` or aggregates will diverge from the raw table.
5. **XR pose is personal data (ADR 0003).** Room-scale head pose/trajectory is sensitive (head
   height, room-walk patterns). Define sampling/rounding/opt-in for pose retention, not just for
   geometry egress.
6. **Head-pose-as-attention is an assumption.** Eye-tracked gaze ≠ head-forward; XR also has
   per-eye, controller, and hand inputs. Confirm `camera_sample.direction` represents the XR head
   rig, and leave a path to real eye-tracking / input-device signals later. Input devices
   (controllers/hands/gaze) are modeled in [ADR 0011](./0011-input-source-agnostic-events.md).

## Consequences

### Positive

- Multi-area projects (entry screen + N levels) become correct: heatmaps are per-scene, not
  smeared across the whole project.
- Camera **pose** capture unlocks world-space gaze/attention analytics — especially valuable for
  WebXR — beyond the abstract direction sphere.
- Reuses the existing replay architecture and the already-landed `worldHeatmapQuery`; the
  dev-integrated overlay (4a) ships value without any asset-hosting or registry.
- Backward-compatible: `scene_id` defaults to `"default"`; existing projects and queries keep
  working.
- The tiered scene-representation model lets the **data-only** and **live-overlay** viewers ship
  with **zero developer input and zero geometry egress**; richer context (proxy/asset) is purely
  opt-in, keeping the privacy-first posture (ADR 0003).
- Generalized and per-session heatmaps reuse one query/aggregation/renderer (differing only by an
  optional `sessionId`), so supporting both scopes is near-free and complements replay rather than
  duplicating it.

### Negative / trade-offs

- Adds a new event-level dimension and a marker event (`scene_change`): schema, SDK, ingestion,
  query, **and the existing 0003–0006 rollups** must change before anything renders (see Open
  Questions 4).
- Several decisions are deferred to the design sketch and Open Questions (gaze raycast location,
  scene versioning, `scene_id` guardrails) — they gate schema/SDK shape and must be resolved early.
- Storing world-space pose/gaze and per-scene rollups adds cost and carries privacy obligations
  (Open Questions 5); sampling rate remains a perf/accuracy trade-off (consistent with ADR 0006).

## Alternatives considered

- **Project-wide voxel binning (no scene dimension)** — simplest, but produces meaningless
  heatmaps for multi-area projects; rejected.
- **Scene as a session-level field** (on `session_start`) — cannot represent a session that moves
  through several areas; rejected in favor of an event-level `scene_id`.
- **Query-time scene resolution from `scene_change` only** — smaller wire footprint, but forces a
  windowed join on every heatmap query; rejected in favor of a denormalized `scene_id` column
  (plus the marker event for replay completeness).
- **Position-only camera heatmap** — half the signal; drops the orientation/gaze that is the most
  valuable part, especially for WebXR; rejected as the primary camera metric.
- **Per-session view via replay only (no per-session heatmap)** — replay shows the ordered
  timeline but not the time-collapsed spatial density of one visit; rejected because the
  per-session heatmap is near-free (an optional `sessionId` filter on the same query) and answers
  a different question.

_Rendering, viewer, and scene-representation alternatives (mesh-baked-first, full-asset-upload,
auto-upload, server-side reconstruction) are recorded in the
[design sketch](../phases/3d-heatmap-rendering-design.md), since those choices are reversible._

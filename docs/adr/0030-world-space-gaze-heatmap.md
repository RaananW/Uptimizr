# ADR 0030: World-space gaze heatmap (camera-pose surface hits)

- **Status:** Accepted
- **Date:** 2026-06-19
- **Deciders:** Project owner, engineering

## Context

[ADR 0010](./0010-spatial-3d-heatmaps.md) made camera **pose** (position + orientation) a
first-class spatial signal and named **world-space gaze** — "raycast of pose into the scene,
accumulated on surfaces; what did people actually look at" — as a first-class 3D heatmap, distinct
from the existing abstract direction sphere ([`buildCameraDirectionHeatmap`](../../oss/packages/db/src/query/aggregations.ts)).
It then deferred the one decision that gates the schema to its **Open Question 1**:

> **Gaze raycast — client or server?** … Either (a) the SDK raycasts each sampled pose
> **client-side** and emits a `hitPoint` like pointers do … or (b) we store **raw pose** and only
> viewers that _have_ the scene resolve surface hits at render time. **Recommendation:** do
> **both** … Needs sign-off because it determines whether `camera_sample` gains a `hitPoint` field.

That question has blocked the highest-value spatial metric for **every** camera style, not just
WebXR:

- **Orbit / arc-rotate viewers** (product configurators, showrooms): "which side / part of the
  model do people actually look at" is the headline question, and most viewers _look_ far more
  than they _click_. Today only **pointer** hits land on surfaces; pure-look attention is invisible.
- **First-person / walkable** scenes: "what draws the eye as people move through the space."
- **WebXR**: head-forward is the usable attention proxy ADR 0010 already calls out.

The view-direction sphere answers "which **direction**" but not "which **surface**"; two scenes with
the same camera angles but different geometry collapse to the same dome. The world (3D) pointer
heatmap answers "which surface" but only where users **clicked**. Neither answers "where did the
audience's gaze rest on the model."

Two facts make the client-side path cheap to adopt:

1. `camera_sample` already carries `position` + `direction` (+ optional `target`, `fov`) — a
   world-space gaze ray per sample is fully reconstructable; only the **surface intersection** is
   missing, and only the client has geometry to compute it.
2. Ingestion already projects any event's `hitPoint`→`hit_point` and `hitMesh`/`mesh`→`mesh`
   columns generically ([`toEventRow`](../../oss/packages/db/src/events.ts)). A gaze hit on
   `camera_sample` lands in the **same columns** the world heatmap already reads — **no migration**.

This ADR records the durable, schema-gating decision deferred by ADR 0010 §Open-Question-1. It does
**not** supersede ADR 0010; it resolves one of its open questions and is additive.

## Decision

### 1. Always store raw pose; add an optional, opt-in, throttled client-side gaze hit

Adopt ADR 0010's recommended "do both":

- **Raw pose is unchanged and always stored** (`camera_sample.position` + `direction`), so viewers
  that own the scene (Tier 0) can resolve surface gaze at render time and the abstract direction
  sphere keeps working with zero new cost.
- **`camera_sample` gains two optional fields** — `hitPoint` (world-space point the camera-forward
  ray hits) and `hitMesh` (the hit object's name) — mirroring the pointer events exactly. They are
  **absent unless the connector is explicitly configured to capture gaze**, so the default wire
  shape and cost are unchanged.

### 2. Gaze capture is opt-in and governed by the camera cadence (ADR 0012)

- Client-side gaze raycasting is **off by default** (privacy + cost, [ADR 0003](./0003-privacy-model.md)
  / [ADR 0012](./0012-sampling-and-fidelity.md)). A developer enables it per-collector.
- A gaze hit is computed **only on a frame that already emits a `camera_sample`** — it rides the
  existing, idle-suppressed camera cadence and never adds its own timer or runs at frame rate.
  One pick per emitted pose is the budget; if pose-dedup suppresses the sample, no pick runs.
- An optional **mesh allowlist** bounds `hitMesh` cardinality and pick cost on large scenes, exactly
  like `mesh_visibility` (ADR 0010 §Open-Question-3 / ADR 0003). A **predicate** escape hatch lets a
  developer exclude ground/skybox/helper meshes from gaze.

### 3. Gaze is a distinct heatmap, not folded into the pointer world heatmap

- A new aggregation **`buildGazeHeatmap`** voxel-bins `camera_sample.hit_point` (the same grid as
  the pointer world heatmap) and is exposed as **`GET /api/v1/heatmaps/gaze`**. Keeping it a
  separate event-type filter (`camera_sample` vs `pointer_*`) means "looked at" and "clicked" stay
  independently queryable and renderable, and the existing world-pointer heatmap is untouched.
- It reuses the world heatmap's parameters (`cellSize`, `scene`, `session`, `cameraMode`, range) and
  the existing `WorldHeatmapBinRow` shape, so one renderer serves both. The generalized/per-session
  scopes of ADR 0010 §1a apply unchanged (an optional `session` filter).

## Consequences

### Positive

- The headline spatial metric — **where the audience's gaze rests on the actual geometry** — ships
  for **every** camera style (orbit, first-person, XR), closing the gap the direction sphere and the
  click-only world heatmap each half-filled.
- **No migration:** gaze hits reuse the `hit_point`/`mesh` columns via the generic `toEventRow`
  projection; only the schema (an optional field), the connector, one aggregation, one route, and
  the dashboard wiring change.
- **Backward-compatible and cheap by default:** the fields are absent unless opted in, capture rides
  the existing camera cadence (no new timer, no frame-rate picking), and Tier 0 viewers can still
  derive surface gaze from raw pose without it.
- Reuses the world heatmap's query path, row shape, and 3D renderer — a separate `gaze` endpoint is
  near-free.

### Negative / trade-offs

- A scene-graph pick per emitted camera sample adds client CPU. Mitigated by riding the
  (idle-suppressed, ~1 Hz default) camera cadence, an optional allowlist/predicate, and opt-in
  framing — but a developer who raises the camera rate _and_ enables gaze on a heavy scene pays for
  it (ADR 0012 governs the budget).
- Head-forward gaze is a **proxy**, not eye-tracked gaze (ADR 0010 §Open-Question-6 stands); a
  centered model can over-attribute gaze to whatever sits at screen center. Documented as a proxy.
- World-space gaze hits are scene-coordinate data and inherit ADR 0010's **scene-content-versioning**
  caveat (§Open-Question-2): heat must not be aggregated across a re-layout. Unchanged by this ADR.

## Alternatives considered

- **Server-side gaze raycast (store raw pose only).** The server has no geometry; it would require
  uploading meshes (privacy/cost regression vs ADR 0003) or a data-only viewer that can never show
  surface gaze. Rejected as the _only_ path; raw pose is still always stored for Tier 0 viewers.
- **Fold gaze into the existing world (pointer) heatmap.** Merging `camera_sample` hits into
  `buildWorldHeatmap` would conflate "looked at" with "clicked" and silently change that endpoint's
  meaning. Rejected in favor of a distinct `gaze` aggregation/endpoint sharing the same row shape.
- **Reuse `mesh_visibility.centeredMs` as the gaze signal.** That is a per-object _dwell duration_
  proxy (gaze ≈ screen-center), not a _world-space surface position_; it cannot produce a spatial
  heatmap on geometry. Complementary, not a substitute.
- **A dedicated `gaze_hit` event type.** Adds a new event, new columns, and a migration for data that
  is definitionally a property of the camera sample. Rejected in favor of two optional fields on
  `camera_sample` (events live once; reuse the existing columns).
- **Capture gaze on its own high-rate timer.** Decouples cost from the pose timeline and risks
  frame-rate picking. Rejected: riding the camera cadence keeps one pick per stored pose and reuses
  idle suppression.

## Connector parity

Gaze capture ships for **every** camera-emitting connector — `@uptimizr/babylon`, `@uptimizr/three`,
`@uptimizr/babylon-lite`, and `@uptimizr/playcanvas` — behind the same opt-in `capture.gaze` flag,
the same `GazeOptions` (`maxDistance`, `meshes` allowlist), and the same one-pick-per-emitted-pose
budget. The hit is normalized to the canonical frame at the emission boundary (ADR 0018): right-handed
connectors (three, PlayCanvas) negate Z; left-handed ones (Babylon, Lite) are identity.

The pick mechanism differs per engine, but the wire shape and cost discipline do not:

- **Babylon** uses `camera.getForwardRay()` + `scene.pickWithRay()` (synchronous), with a `predicate`
  escape hatch.
- **three** casts a single reused `THREE.Raycaster` from NDC centre `(0, 0)` (synchronous, `far`
  clamps the ray), with a `predicate` over `Object3D`.
- **PlayCanvas** casts a single reused `pc.Ray` from the screen-centre pixel against mesh-instance
  world AABBs (synchronous, physics-free — no `ammo`), with a `predicate` over the hit `GraphNode`.
- **Babylon Lite** has only an **async GPU picker**, so it picks the centre pixel once per emitted
  pose and attaches the resolved hit to the **next** sample (≤ one camera-sample of latency, a
  documented divergence). It has no per-mesh predicate — only the name allowlist + `maxDistance`.

The three-wrapping connectors inherit gaze from `@uptimizr/three` with no new picking code:

- **`@uptimizr/r3f`** reuses three's `TrackSceneOptions` verbatim, so `capture.gaze` + `gaze`
  (`maxDistance`/`meshes`/`predicate`) pass straight through `useUptimizr` / `<Uptimizr>`.
- **`@uptimizr/aframe`** exposes a flat HTML-attribute schema, so it adds a boolean `gaze` toggle
  (`<a-scene uptimizr="gaze: true">`) that maps to `capture.gaze`. The allowlist/predicate can't be
  expressed as an attribute, so the three connector's `GazeOptions` defaults apply.

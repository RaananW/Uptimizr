---
title: Concepts
description: The core ideas behind Uptimizr — events, the envelope, scenes, heatmaps, sessions, and replay.
---

A short tour of the vocabulary you'll meet throughout these docs.

## Events & the envelope

Everything Uptimizr captures is an **event**. Every event shares a common **envelope** — it is
ordered, timestamped, and keyed by `sessionId` — and a typed payload. All event shapes live once,
as Zod schemas, in `@uptimizr/schema`; connectors and the collector import them rather than
redefining them. This is what makes a session **replay-complete**: the ordered event stream is
enough to reconstruct what happened.

Events fall into two groups:

- **Continuous channels** — `camera_sample`, `pointer_move`, `frame_perf`. Sampled at a configurable
  rate (Hz) and idle-suppressed.
- **Discrete events** — `pointer_click`, `mesh_interaction`, `scene_change`, `custom`,
  `session_start`/`session_end`, and more. Always captured at 100%; cannot be rate-limited.

## Sessions & visitors

A **session** is one continuous visit, identified by an in-memory `sessionId` that never touches
disk on the client. A **visitor** is counted with a hash computed **server-side** that rotates
every day — so visits can be de-duplicated within a day without tracking anyone across days. There
are no cookies and no persistent client identifiers (see [Privacy](/docs/deploy/privacy/)).

## Scenes

A **scene** is a named area, level, or view within your app. Call `tracker.setScene("level-2")` (or
pass `meta.sceneId`) to segment analytics. Most query endpoints accept a `scene` filter so you can
scope a heatmap to one area.

Optionally, a scene can register a lightweight **proxy** of its geometry (per-mesh bounding boxes)
so the dashboard can draw 3D heatmaps against a recognizable backdrop without your real assets.

## Heatmaps

Uptimizr aggregates raw spatial events into several heatmap types:

- **Pointer heatmap** — 2D screen-space hover/click density.
- **World heatmap** — 3D world-space pointer density, voxel-binned.
- **Camera (view-direction) heatmap** — spherical bins of where the camera looked.
- **Gaze heatmap** — world-space points where the audience actually looked on the geometry
  (opt-in).
- **Click rays / flow** — clicks ray-cast into the scene, and gaze→mesh flow links. Pose inputs
  (XR controllers, hands, gaze) use their own pointing-ray origin; flat pointers (mouse, touch,
  stylus) reconstruct the ray origin on the camera's near plane from the click's screen position
  (ADR 0041), so the rays fan out the way the clicks were actually made.

In **first-person / walkable** scenes that use the browser Pointer Lock API, the cursor is hidden and
the aim point is the fixed crosshair at the viewport centre. The connectors detect pointer lock and
report pointer/click events from screen centre (ADR 0034), so the 2D pointer heatmap naturally
clusters at the centre — for those scenes read the cursor-independent **gaze heatmap**, the
floor-plan position heatmap, and session trajectories instead.

## Performance

`frame_perf` samples carry FPS, frame time, long-frame counts, and draw metrics. The query API
returns percentile aggregates (median/p50, min, avg) so a "p95 frame time" is one request away.

## Replay

Because the event stream is replay-complete, a recorded session can be **re-driven** inside your
own scene — re-applying the visitor's camera, pointer, and interactions (and, opt-in, scene-actor
motion). Replay reads the raw, ordered event stream, which requires the collector to run with
`ENABLE_RAW_SESSION_RETENTION` enabled.

# ADR 0048: AR/VR spatial analytics — placement, boundary proximity, tracking quality

- **Status:** Proposed
- **Date:** 2026-07-04
- **Deciders:** Project owner, engineering

## Context

Uptimizr already captures XR sessions through the source-neutral vocabulary added by ADR 0011 /
ADR 0023 / ADR 0025: `source` (`xr-controller` / `hand` / `gaze`), `handedness`, world-space rays,
and `camera_gesture { kind: "fly" }` for thumbstick locomotion and teleport. That is enough to
reuse the existing 2D/3D panels (heatmaps, dome, navigation mix) for XR sessions, but it cannot
answer the questions that are **specific to AR/VR**, which today require no event at all:

- **AR placement (retail "view in your room"):** how long did it take to place the model, how many
  times did the visitor re-place/re-scale it, what surface did it land on, and what scale did they
  settle on relative to the model's real-world default? This is the AR equivalent of "did they add
  it to cart," and it is entirely invisible today.
- **Room-scale boundary proximity (VR comfort):** did visitors repeatedly back into their guardian/
  boundary during a session? Frequent boundary contact is a strong discomfort/frustration signal
  (the physical space didn't fit the experience) that game studios cannot see today.
- **Tracking quality:** hand-tracking and inside-out controller tracking degrade or drop under
  occlusion or poor lighting. A session that "felt fine" in the perf/FPS metrics can still have been
  unusable because the user's hands kept disappearing — a distinct failure mode perf metrics don't
  capture.

None of these fit an existing event cleanly, and privacy is a sharper concern here than elsewhere:
room-scale boundary geometry can reveal the shape/size of someone's home. ADR 0003's "no PII, coarse
by default, opt-in for anything richer" stance applies directly and constrains the design below —
this ADR does not propose ever capturing raw guardian/boundary polygons or room geometry.

## Decision

Three additive signals, deliberately kept minimal and reusing existing promoted storage columns
(`position`, `mesh`, `source`/`handedness`) wherever possible so **no database migration is
required** (same pattern as ADR 0030's gaze `hitPoint` reusing `hit_point`).

### 1. New event: `ar_placement`

A discrete, source-neutral lifecycle event for AR object placement, emitted once per placement
"settle" (not per frame):

- `mesh` — the placed model/asset name (existing promoted column).
- `position` — final world position (existing promoted column).
- `surface` — coarse enum: `"floor" | "wall" | "table" | "ceiling" | "unknown"`.
- `attempts` — number of place/re-place actions before this settle.
- `timeToPlaceMs` — from AR session start (or "enter placement mode") to this settle.
- `scale` — final scale relative to the model's authored real-world size (`1` = actual size).
- `final` — whether this is the last placement recorded for the session (so a funnel/conversion
  query doesn't have to guess).

Rides in `payload` (JSON) like `compile_stall`/`asset_load`'s non-hot fields; only `mesh` and
`position` need to be queryable as columns, and both already exist.

### 2. New event: `xr_boundary_proximity`

Reports that the visitor's tracked position **approached their configured guardian/boundary**,
without ever transmitting the boundary's shape or dimensions:

- `position` — the camera/HMD position at the moment of closest approach (existing column; a coarse
  voxel bin like every other world-space signal — ADR 0010's binning already protects precision).
- `durationMs` — how long the visitor stayed within the "near boundary" zone.
- `count` implied by event frequency (one event per approach, not a running counter), consistent
  with how `hover_dwell`/`compile_stall` emit one bucketed event per occurrence rather than a
  stream.

The WebXR bounds-check ("is the tracked pose within N cm of the boundary") happens **entirely on
device**; only the outcome (a position + duration) is ever sent. No boundary polygon, room size, or
raw sensor data is captured or stored — this keeps the signal within ADR 0003's default posture with
no new opt-in flag needed.

### 3. Extend `capability_change` with a `"tracking"` kind

Rather than a fourth new event type, tracking-quality transitions are modeled as another
`capabilityChangeKindSchema` value (alongside `graphics-backend` / `quality` / `device-recovery` /
`feature` / `other`), consistent with "events live once": a tracking drop is a capability state
change, exactly like a WebGPU→WebGL2 fallback.

- `kind: "tracking"`, `from`/`to` — short tokens such as `"6dof"` → `"3dof"`, `"hand"` → `"lost"`,
  `"controller"` → `"occluded"` → `"controller"`.
- Carries the existing `source`/`handedness` shape (ADR 0011) so a dashboard can split by which
  hand/controller degraded.
- App/connector-reported, same as the existing `device-recovery` kind — engines rarely expose a
  clean "tracking confidence" callback, so this is best-effort and app-triggerable via the existing
  `client.reportCapabilityChange(...)` call.

## Consequences

### Positive

- Unlocks three graphs with concrete, previously-impossible retail/VR/game insight: **AR placement
  funnel**, **guardian/boundary-touch heatmap**, **tracking-quality timeline** (tracked as follow-up
  issues once this ADR lands).
- Zero database migration — every new field either reuses an existing promoted column or rides in
  `payload`, matching the established low-friction pattern for additive events.
- Stays inside ADR 0003 by construction: boundary geometry never leaves the device, only a coarse
  position + duration.

### Negative / trade-offs

- `ar_placement` and `xr_boundary_proximity` are new event types connectors must implement per
  engine/XR framework (WebXR device API first; native AR frameworks — ARKit/ARCore via a future
  native connector — later, per ADR 0045's web-export direction).
- Tracking-quality reporting is best-effort and app-triggered (like `device-recovery`), so coverage
  depends on what each XR runtime actually exposes — it will under-report on runtimes with no
  tracking-confidence signal at all.
- "Near boundary" thresholding logic lives in the connector, not the schema, so its sensitivity
  (what counts as "near") is not standardized across connectors; document a recommended default in
  the `add-connector` skill.

## Alternatives considered

- **Capture raw boundary/guardian polygons for a true spatial map.** Rejected outright: this is
  precise real-world room geometry, a materially different privacy category than anything else
  Uptimizr stores, and not needed to answer "did visitors keep bumping into their space."
- **Model AR placement as a `mesh_interaction` kind (e.g. `"place"`).** Rejected: placement has
  multiple attempts, a settle scale, and a surface classification that don't fit the single-shot
  interaction shape; forcing it in would either lose data or bloat `mesh_interaction` with
  AR-only optional fields used by no other kind.
- **A dedicated `tracking_quality` event type instead of extending `capability_change`.** Rejected
  per "events live once": tracking quality is semantically a capability transition, and
  `capability_change` already carries the exact `from`/`to`/`reason` shape needed.

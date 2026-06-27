# ADR 0041: Near-plane origin for flat-pointer click rays

- **Status:** Accepted
- **Date:** 2026-06-24
- **Deciders:** Uptimizr maintainers

## Context

The click-ray heatmap (`/api/v1/heatmaps/click-rays`, `buildClickGazeRay`) answers "from where,
and along which direction, did the audience click into the scene?" Each ray has an **origin** and
a **direction**.

Pose-enabled inputs — XR controllers, tracked hands, eye gaze — carry a native pointing ray, so
ADR 0011 keeps their captured `ray.origin` verbatim. Flat pointers (mouse, touch, stylus) have no
native pointing ray: the only spatial data is the 2D `screen[x, y]` of the click plus the camera
pose. Until now every flat click collapsed to a single point — the nearest preceding
`camera_sample` **position** — so the whole flat-pointer ray fan started from one camera voxel.

That is not where a mouse click originates. A click originates where the cursor sits on the
camera's **near plane**, along the view ray. We already capture `screen` on `pointer_click` and the
camera `position` + `direction` on `camera_sample`; the missing ingredients are the camera's
projection intrinsics (vertical FOV, viewport aspect, near distance).

Forces:

- **Fidelity** (issue #22): reconstruct a physically faithful ray origin for flat pointers without
  disturbing pose sources.
- **Engine parity (ADR 0020):** the reconstruction must compute identically on DuckDB (OSS) and
  ClickHouse (scale tier), so it can only use plain arithmetic — no engine-specific functions.
- **Backwards compatibility:** legacy events and existing parity fixtures have no intrinsics; they
  must keep the old camera-position behaviour rather than break or drop rows.
- **Events live once (`@uptimizr/schema`):** any new field is added to the canonical
  `camera_sample` schema, never redefined downstream.

## Decision

Thread the camera's projection intrinsics through the pipeline and unproject flat-pointer clicks
onto the near plane:

1. **Schema** — add optional `aspect` and `near` to `camera_sample` alongside the existing `fov`
   (vertical, radians). All optional and replay-friendly.
2. **SDK** (`@uptimizr/babylon`) — capture `aspect` (`engine.getAspectRatio(camera)`) and `near`
   (`camera.minZ`) next to `fov`, emitting each only when finite and positive.
3. **Storage** — promote `fov`/`aspect`/`near` to dedicated `DOUBLE`/`Float64` columns in both the
   DuckDB and ClickHouse event tables (forward-only `ALTER TABLE` migrations), with `0` as the
   absent sentinel.
4. **Aggregation** (`buildClickGazeRay`) — for flat pointers with a `screen` and all three
   intrinsics present, reconstruct the origin on the near plane; otherwise fall back to the camera
   position exactly as before.

### Geometry

Given click `screen = [sx, sy]` (normalized, origin top-left) ASOF-joined to camera pose `P`
(position), unit forward `F`, and intrinsics `fov`/`aspect`/`near`:

- `ndcx = 2*sx - 1`, `ndcy = 1 - 2*sy` (screen y is top-down; NDC y points up).
- Camera basis from **canonical world-up** `U = (0, 1, 0)` assuming **no roll** (Babylon
  `LookAtLH`): `right = normalize(cross(U, F)) = normalize(Fz, 0, -Fx)`, `up = cross(F, right)`,
  with `hlen = sqrt(Fx² + Fz²)`.
- `halfH = near * tan(fov/2)`, `halfW = halfH * aspect`.
- `origin = P + F*near + right*(ndcx*halfW) + up*(ndcy*halfH)`.

Per-axis preference order in the `CASE`: (a) native ray origin (pose sources), (b) reconstructed
near-plane point, (c) camera position, (d) `NULL` (row dropped).

**Degenerate guard:** when the camera looks straight up or down, `hlen → 0` and the `right`/`up`
basis is undefined. The reconstruction requires `hlen > 1e-6 * dlen`; otherwise it falls back to
the camera position.

## Consequences

### Positive

- Flat-pointer click rays now fan out from where each click landed on the near plane, so the
  averaged `origin_x/y/z` reflects true click geometry instead of a single camera voxel.
- Pose sources are untouched (ADR 0011 preserved); legacy/intrinsic-free data degrades gracefully
  to the previous camera-position behaviour, so existing parity goldens are unaffected.
- Pure-arithmetic SQL keeps DuckDB/ClickHouse parity (ADR 0020).

### Negative / trade-offs

- The near plane is physically tiny (`minZ ≈ 0.1`), so the spatial spread between clicks is subtle;
  the fidelity lives in the averaged origin rather than in dramatic voxel fan-out.
- Assumes canonical world-up with no camera roll. Rolled cameras (rare for flat pointers) would
  reconstruct a slightly rotated near-plane point; this is accepted and falls back cleanly when the
  basis degenerates.
- Three extra columns per event in both stores.

## Alternatives considered

- **Keep the camera-position fallback for flat pointers** — simplest, but exactly the low-fidelity
  behaviour issue #22 set out to fix.
- **Configurable reconstruction distance along the view ray** instead of the true near plane —
  rejected in favour of the physically faithful near plane (explicit product decision); a tunable
  distance adds a knob without a clear analytics benefit.
- **Capture a full projection matrix on `camera_sample`** — more general (handles roll, off-axis
  frustums) but heavier on the wire and in storage, redefines what `camera_sample` carries, and is
  unnecessary for the mouse/touch/no-roll case this targets.

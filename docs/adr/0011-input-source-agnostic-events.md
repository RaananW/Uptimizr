# ADR 0011: Input-source-agnostic interaction events

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** Project owner, engineering

## Context

The interaction events today were shaped around a **mouse on a flat screen**:

- `pointer_move`, `pointer_click`, `pointer_down`/`pointer_up` all carry `screen` (normalized 2D
  `[x, y]`, origin top-left) plus optional `hitPoint` (world raycast) and `hitMesh`. The button
  family adds `button: number` (0/1/2).
- `mesh_interaction` carries `mesh` + `kind` (`hover` | `pick` | `click` | `drag`) + optional
  `point`. Notably, this one is **already input-agnostic** — no `screen`, no button.

This silently assumes the input device is a mouse. It breaks in **WebXR** (and is awkward for
touch/stylus), where there is **no screen-space cursor**. Instead there are up to four simultaneous
sources — **two controllers and two hands** — each of which is a **world-space ray** (origin +
direction) with its own actions (trigger/grip/thumbstick for controllers; pinch/grab/point for
hands), plus **gaze** (the head ray is the pointer) and **transient** pointers (phone-AR tap that
exists for a single frame). Multi-touch likewise has N concurrent points, not one.

The valuable, analytics-relevant part of an interaction — _"a source selected this object at this
world point"_ — is **already source-neutral**. Only the `screen` field and the integer `button`
are mouse-specific. So we do not need a parallel family of XR events; we need the interaction model
to stop assuming the source is a mouse, and to mirror the vocabulary the platform already
standardizes ([WebXR `XRInputSource`](https://www.w3.org/TR/webxr/): `handedness`, `targetRayMode`,
grip vs. target ray, gamepad, hand joints) so connectors map 1:1.

Continuous **pose** is handled separately: `camera_sample` already streams the head/camera pose
over time. Whether controllers/hands get their own continuous pose stream, and how that volume is
governed, is a **fidelity/sampling** concern decided in [ADR 0012](./0012-sampling-and-fidelity.md),
not here.

## Decision

Make interaction events **input-source-agnostic** by adding a small, shared, source-describing
vocabulary, keeping `mesh_interaction` as the primary source-neutral signal, and keeping the
`pointer_*` family as the flat-screen capture path rather than renaming it.

1. **`source` discriminator (shared).** A low-cardinality `inputSourceSchema` enum, mirroring
   WebXR target-ray modes and common flat inputs:
   `"mouse" | "touch" | "stylus" | "pen" | "xr-controller" | "hand" | "gaze" | "transient" | "other"`.
   It defaults to `"mouse"` so existing events and SDK call sites remain valid
   (backward-compatible). New kinds can be appended without a breaking change.
2. **`handedness` (shared, optional).** `"left" | "right" | "none"` to disambiguate the two
   controllers/hands. Absent ⇒ not applicable (e.g. mouse, gaze).
3. **`sourceId` (shared, optional).** A short, **session-local, non-persistent** identifier that
   correlates a concurrent stream and brackets a `pointer_down`→`pointer_up` pair to the _same_
   source when several are active (two controllers, multi-touch). It MUST NOT be a stable
   device/user identifier (ADR 0003) — it is an ephemeral disambiguator only.
4. **World-space ray (optional).** Add an optional `ray` (origin `vec3` + direction `vec3`) for
   sources that are natively rays (XR controllers/hands, gaze). `hitPoint` already captures the
   ray _result_ on geometry (what heatmaps consume); `ray` captures _where the user pointed from_,
   which replay and "pointing origin" analytics need. `screen` becomes **optional** — present for
   flat inputs, absent for ray/world inputs.
5. **`mesh_interaction` is the primary source-neutral interaction signal.** It gains the same
   optional `source` / `handedness` / `sourceId`. Its `kind` enum stays extensible; XR actions
   (e.g. `select`, `squeeze`/grip, `grab`, `release`, `teleport`) are added as new `kind` values
   rather than as new event types. A discrete XR "select" is a `mesh_interaction`, not a
   `pointer_click`.
6. **`pointer_*` stays the flat-screen path.** We do **not** rename the family to `input_*`.
   Mouse/touch/stylus flow through `pointer_*` (now carrying `source`); world-space XR interactions
   flow through `mesh_interaction` (+ the pose stream from ADR 0012). This avoids superseding three
   existing events for a cosmetic rename while still capturing every source.
7. **Storage & ingestion.** New optional columns (`source` `LowCardinality(String)` default
   `'mouse'`, `handedness` `LowCardinality(String)`, `source_id String`, and ray origin/direction
   as `Array(Float32)`), added with the same additive, backfill-`DEFAULT` pattern used for other
   columns (ADR 0007). Spatial heatmap queries (ADR 0010) gain an **optional `source` filter** so a
   heatmap can be "all inputs" or "right-hand only," reusing the one aggregation/voxel pipeline.

## Consequences

### Positive

- One interaction pipeline covers mouse, touch, stylus, XR controllers, hands, and gaze; a
  controller hit and a mouse click land in the **same** world-space heatmap, filterable by
  `source` (extends ADR 0010 without a new aggregation).
- Backward-compatible: `source` defaults to `"mouse"`, `screen`/`button` stay for flat inputs,
  existing events/SDK calls are unchanged.
- Mirrors the WebXR standard, so the Babylon WebXR connector (and future engine connectors) map
  their input abstractions onto our vocabulary directly instead of inventing a parallel ontology.
- `mesh_interaction` "which object did they engage" becomes device-complete (handedness, source)
  without fragmenting into per-device event types.

### Negative / trade-offs

- Events get slightly wider (a few optional fields); high-volume `pointer_move` gains optional
  `source`/`ray`. Mitigated by the sampling/cost controls in ADR 0012 and by `source` defaulting
  out for the common mouse case.
- Keeping `pointer_*` named "pointer" while it now also represents touch/stylus stretches the name;
  accepted to avoid superseding existing events.
- Concurrent-source correlation depends on `sourceId` being emitted consistently per connector;
  connectors must map their native pointer IDs carefully.
- Hand-joint / room-scale capture is **biometric-adjacent** personal data; retention depth and
  rounding are governed by the privacy model (ADR 0003) and the fidelity dial (ADR 0012), not left
  to default-on capture.

## Alternatives considered

- **New per-device event family** (`xr_select`, `hand_pinch`, …) — explicit, but fragments the
  aggregation, duplicates `hitPoint`/`hitMesh`, and forces replay/heatmap code to special-case each
  device; rejected in favor of a `source` discriminator on the existing events.
- **Generic `interaction` event superseding `pointer_*`** (rename to source-tagged `input_*`) —
  cleanest long-term model, but supersedes three shipped events and a lot of SDK/connector code for
  mostly cosmetic gain; deferred — `source` on the existing events gets ~all the benefit now.
- **Position-only / screen-only XR mapping** (cram XR into `screen`) — meaningless for world-space
  rays and loses the pointing origin; rejected (`ray` + optional `screen` instead).
- **A persistent per-device id** to correlate streams — would re-introduce a stable client
  identifier banned by ADR 0003; rejected in favor of an ephemeral session-local `sourceId`.

## Open questions

1. **Continuous controller/hand pose stream** — does it reuse `camera_sample`'s shape under a
   `source` tag, or a dedicated `input_pose` event? Decided alongside ADR 0012 (sampling), since it
   is primarily a volume/fidelity question.
2. **Teleport locomotion** — teleport discontinuously jumps the camera, breaking the continuous
   trajectory assumption in occupancy heatmaps (a jump is not walking). Likely its own
   `mesh_interaction` kind or a marker event; to be specified when WebXR locomotion lands.
3. **XR reference space** — poses live in a reference space (`local` / `local-floor` / `bounded` /
   `unbounded`). Floor-relative height matters for analytics and ties to the scene registry's
   up-axis/unit scale (ADR 0010). Capture the reference space with XR sessions.

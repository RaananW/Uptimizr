# ADR 0018: Canonical world coordinate frame and connector provenance

- **Status:** Accepted
- **Date:** 2026-06-17
- **Deciders:** Project owner, engineering

## Context

Babylon.js is the only connector implemented today, and it is also the engine the dashboard uses
to render collected data (heatmap backdrops, the scene-proxy viewer, replay). Babylon is a
**left-handed, y-up** engine. The Babylon adapter currently emits **raw native coordinates with no
normalization** — [`vec.ts`](../../oss/packages/sdk-babylon/src/vec.ts) is literally `[v.x, v.y,
v.z]`, and [`proxy.ts`](../../oss/packages/sdk-babylon/src/proxy.ts) reads Babylon world AABBs
straight through. So every **world-space** value on the wire (camera pose `position`/`direction`,
`mesh_interaction` world points, `hitPoint`, scene-proxy boxes) is implicitly expressed in
Babylon's left-handed, y-up frame.

This is invisible while Babylon is the only producer _and_ consumer, but it becomes a correctness
problem the moment a second connector is added:

- **Babylon** — left-handed, y-up.
- **three.js / glTF** — right-handed, y-up.
- **PlayCanvas** — right-handed, y-up.

Left- vs. right-handed differ by a single-axis flip (conventionally Z). If a right-handed engine's
data were ingested as-is and rendered by the Babylon-based dashboard, world-space heatmaps would be
**mirrored along Z** — heat lands on the wrong side of objects and camera poses point backwards.
Screen-normalized data (pointer/click heatmaps) and the abstract spherical gaze sphere are
**not** affected, because they are not expressed in the source world frame.

Two existing fields are easy to mistake for a solution but are unrelated:

- `handedness` on interaction events (ADR 0011) is the **XR controller hand** (`left`/`right`/
  `none`), not coordinate-system handedness.
- `device.engine` on `session_start` is the **graphics backend** (`webgl2`/`webgpu`), not the
  library (`babylon`/`three`).

The scene proxy already records `upAxis` (`y`/`z`) and `unitScale` ([`sceneProxy.ts`](../../oss/packages/schema/src/sceneProxy.ts)),
which shows the instinct is right — it is just missing **handedness** and a **connector identity**,
and `session_start` records neither.

## Decision

### 1. One canonical world frame on the wire: left-handed, y-up, unit scale 1

All **world-space** payloads (positions, directions, hit points, scene-proxy AABBs) are defined to
be in a single canonical frame: **left-handed, y-up, 1 world unit**. This matches Babylon, which is
both the first connector and the dashboard renderer, so the common case needs **zero conversion**
and the existing data and dashboard stay correct unchanged.

A connector whose engine uses a different native frame **must normalize world-space data to the
canonical frame at the emission boundary** (e.g. a right-handed engine negates Z on positions and
directions, and on proxy AABB bounds). This follows the "events live once / engine-agnostic"
principle (AGENTS.md, ADR 0010): consumers never branch on the source engine to interpret geometry.

Screen-space and direction-sphere data are already engine-independent and are unaffected.

### 2. Record connector provenance on `session_start` (metadata, per default)

`session_start` gains an optional **`connector`** block describing where the session came from and
the source engine's **native** coordinate frame, captured once per session:

- `name` — connector/engine id, e.g. `"babylon"`, `"three"`, `"playcanvas"`.
- `version` — connector adapter (`@uptimizr/<engine>`) version (optional).
- `coordinateSystem` — the engine's **native** frame: `handedness` (`left`/`right`), `upAxis`
  (`y`/`z`), `unitScale`.

This is **provenance/audit data**, not a rendering instruction: the wire data is always canonical
(§1); `coordinateSystem` records what the source frame _was_, so the conversion is traceable and a
consumer has an escape hatch if it ever needs to invert. The scene proxy likewise gains an optional
`handedness` to make proxy geometry fully self-describing alongside its existing `upAxis`/
`unitScale`.

The block is `.passthrough()` and fully optional, so it is backward-compatible and rides along in
the stored `session_start` JSON payload — **no database migration is required**. The Babylon
adapter populates it by default with `name: "babylon"` and `{ handedness: "left", upAxis: "y",
unitScale: 1 }`.

## Consequences

### Positive

- A second connector can be added without breaking world-space heatmaps or the dashboard.
- Every session is self-describing: its origin engine and native frame are recorded for future
  analysis, debugging, and migrations.
- No migration, no change to existing Babylon data, no dashboard change.

### Negative / trade-offs

- Non-Babylon connectors carry a small normalization responsibility at emission, which must be
  covered by their tests (encoded in the `add-connector` skill).
- The recorded `coordinateSystem` describes the _source_, while the payload is _canonical_; this
  split must be documented so it is not misread as "the data is in this frame."

## Alternatives considered

- **Store raw per-engine coordinates + a frame tag; convert at read/render time.** Rejected:
  pushes engine-specific branching into every consumer (dashboard, exports, agents), violating the
  engine-agnostic event contract.
- **Pick a right-handed/glTF canonical frame.** More "industry standard," but would require
  converting all existing Babylon data and the Babylon-based dashboard renderer now, for no present
  benefit. Revisit only if a right-handed renderer becomes primary.
- **Metadata only, no normalization.** Rejected: recording the frame does not make a Babylon
  renderer draw right-handed data correctly; someone still has to convert.

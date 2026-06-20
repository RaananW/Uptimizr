# Design sketch — scene-analytics metrics expansion

> **Status:** Mutable design notes (not an ADR). Captures the backlog of additional 3D-scene
> metrics we want to capture beyond today's `camera_sample` / `pointer_*` / `mesh_interaction` /
> `frame_perf` set, plus the generalization of interaction events from "pointer" to a true
> **input** abstraction (keyboard, gamepad, XR controllers — the same way we support mouse).
> The durable parts (new event shapes, decisions that are hard to reverse) graduate to the
> [event schema](../../oss/packages/schema) and to new ADRs. See [phase plans](./README.md) and
> the work-tracking split in [ADR 0016](../adr/0016-work-tracking.md). **Status: partially shipped**
> — §A `mesh_visibility` dwell, §D `hover_dwell`, and §G input generalization (keyboard/gamepad +
> the `input_action` event, [ADR 0023](../adr/0023-input-action-and-keyboard-gamepad.md)) are
> implemented; the remaining catalog rows (e.g. the optional AABB ride-along) stay proposed.

## How this doc is the map, and issues are the pieces (ADR 0016)

This sketch is the **map**: it holds the rationale, the proposed shapes, and the priority order so
they stay reviewed-via-PR and versioned next to the code. Each row in the catalogs below is sized
to become **one GitHub Issue** (the moving piece) — labeled `event-type` / `enhancement`, grouped
under a **"Metrics expansion"** milestone, and linking back to its section here. We do **not**
duplicate the task list in both places: when a row graduates to an issue, the issue references this
section rather than copying it. Significant or hard-to-reverse choices (notably the input
generalization in §G) still get their own ADR.

## Design principles (carried from AGENTS.md / ADRs)

- **Events live once** in `@uptimizr/schema` (Zod), engine-neutral. The Babylon adapter maps
  engine observables onto them so future connectors (three.js, PlayCanvas) reuse the same shapes.
- **Replay-complete:** every new event is ordered, timestamped, `sessionId`-keyed, and gets a
  handler (visual or no-op) in the replay driver.
- **Derive before you capture.** Several high-value metrics are computable server-side from streams
  we already collect (`camera_sample` + the [scene proxy](../../oss/packages/schema/src/sceneProxy.ts)).
  Prefer a query/rollup over a new client event when fidelity allows — no SDK change, no volume.
- **Privacy first (ADR 0003):** no new persistent IDs; world-space/biometric-adjacent data (hand
  joints, room scale) is rounded/retention-gated, never default-on.
- **Fidelity/sampling (ADR 0012):** high-frequency signals are bucketed/debounced, not per-frame.
  Dwell is aggregated client-side; jank is thresholded; pose-like streams reuse the fidelity dial.
- **Source-neutral (ADR 0011):** anything interaction-shaped reuses `inputSourceShape`
  (`source` / `handedness` / `sourceId` / `ray`) rather than becoming mouse-specific.

---

## A. Object attention / dwell — the biggest gap (highest priority)

We track _interactions_ with meshes and where the camera _is_, but not **what was on screen, how
prominently, and for how long**. This is the 3D analog of scroll-depth + time-on-element and is the
metric configurator / e-commerce / architecture users most often ask for.

| Signal            | Kind          | Payload (beyond envelope)                                                                | Default | Why it matters                                                                                                                                                                   |
| ----------------- | ------------- | ---------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mesh_visibility` | **New event** | `mesh`, `visibleMs`, `centeredMs?` (near screen-center gaze proxy), `maxScreenFraction?` | opt-in  | Per-object dwell + prominence. Frustum/occlusion is per-frame client work the server can't cheaply do — needs a client event, aggregated into buckets (ADR 0012), not per-frame. |

Notes: needs the scene proxy AABBs for screen-fraction; emit one bucketed summary per object per
window, not a stream. A gaze proxy (`centeredMs`) gives "looked at" without eye-tracking.

**Optional bounding-box ride-along (extends `mesh_visibility`, opt-in).** When enabled, attach each
seen object's world-space AABB (reusing [`aabbSchema`](../../oss/packages/schema/src/sceneProxy.ts))
to its dwell summary so the dashboard can render a coarse **"ghost" reconstruction of the scene**
(one box per observed object) and lay dwell heat on it — with no access to the host's real geometry.
Boxes are universally supported by every engine and are near-static, so send one per object (or only
on change beyond an epsilon), not per window. This overlaps the static [scene proxy](../../oss/packages/schema/src/sceneProxy.ts)
(ADR 0010/0014): the ride-along wins for **runtime/dynamic** scenes (animated, procedurally placed,
lazily loaded) and needs no separate scan/upload, while the proxy stays best for fully-static scenes.
Converge on the proxy's `aabb` shape so the dashboard renderer is shared. Opt-in for volume + layout
privacy (ADR 0003).

## B. Spatial engagement — mostly derivable, low cost

| Signal                      | Kind                                   | Source                                        | Why it matters                                                            |
| --------------------------- | -------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| Scene coverage / dead zones | **Derived**                            | `camera_sample` + scene AABB                  | Exploration completeness ("saw 40% of the scene") and never-seen regions. |
| Camera distance / zoom      | **Derived**                            | `camera_sample` distance to target/scene AABB | Proxy for engagement intensity (how close users get to the subject).      |
| Navigation effort           | **Derived (+ optional `idle` marker)** | `camera_sample` travel distance, oscillation  | Friction / "lost user" detection; idle vs. active time.                   |

These need **no client change** — they are query/rollup work over existing data. Cheapest wins.

## C. Performance depth — `frame_perf` averages away the pain

`frame_perf` gives windowed FPS + frame time + draw calls. Averages hide the stalls users feel.

| Signal                        | Kind                                                                 | Payload / source                            | Default | Why it matters                                                                                       |
| ----------------------------- | -------------------------------------------------------------------- | ------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| Jank / long-frame             | **New event** `frame_jank` (or extend `frame_perf` with percentiles) | `frameTimeMs`, plus p95/p99 on the window   | on      | Smoothness is the worst 1%, not the mean.                                                            |
| Shader/pipeline compile stall | **New event** `compile_stall`                                        | `durationMs`, `phase?`                      | on      | #1 source of first-interaction hitches on WebGPU/WebGL.                                              |
| Render resolution used        | **Extend** `frame_perf`                                              | `dpr`, `renderScale`                        | on      | "60 FPS" is hollow if achieved at 0.5× resolution.                                                   |
| GPU / memory footprint        | **New event** `resource_sample`                                      | texture/geometry bytes, tris/verts, JS heap | opt-in  | Actual cost over time (vs. `session_start.device` caps); correlates with mobile crashes/abandonment. |
| Time-to-interactive           | **Extend** `asset_load`                                              | `ttiMs` (distinct from existing `ttffMs`)   | on      | First frame ≠ usable scene (assets still streaming).                                                 |

## D. Interaction quality / frustration — cheap, reuse the hit-test

| Signal      | Kind                                               | Payload (reuses `inputSourceShape`)             | Default | Why it matters                                         |
| ----------- | -------------------------------------------------- | ----------------------------------------------- | ------- | ------------------------------------------------------ |
| Dead clicks | **New / extend** `pointer_click` (emit the misses) | existing payload, `hitMesh` absent ⇒ dead click | on      | High dead-click rate = discoverability problem.        |
| Rage clicks | **Derived (+ optional marker)**                    | rapid repeats on same non-responsive mesh       | n/a     | Frustration signal; mostly a query over click streams. |
| Hesitation  | **New event** `hover_dwell`                        | `mesh`, `dwellMs` (hover without action)        | opt-in  | "Users don't realize this is interactive."             |

## E. Robustness — extend what we have

| Signal               | Kind                              | Source                                                                      | Why it matters                                                                                     |
| -------------------- | --------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Capability fallbacks | **New event** `capability_change` | WebGPU→WebGL2 downgrade, LOD/quality auto-downgrade, device-lost _recovery_ | Explains perf / visual-fidelity variance across the user base. Pairs with existing `context_loss`. |

## F. XR comfort (phase-dependent)

When XR is in scope (note ADR 0011 already models `input_source` / `handedness` / teleport):

| Signal                    | Kind        | Why it matters                                 |
| ------------------------- | ----------- | ---------------------------------------------- |
| Motion-sickness proxy     | **Derived** | Rapid head-rotation rate over the pose stream. |
| XR session abandonment    | **Derived** | Comfort / content drop-off in headset.         |
| Hand vs. controller usage | **Derived** | From `source` on existing interaction events.  |

---

## G. Generalize interaction events from "pointer" to "input" (needs a new ADR)

**Request:** mouse clicks are first-level events; abstract them to a true _input_ layer so
keyboard, gamepads, and XR controllers are supported the same way as mouse.

**What already exists (ADR 0011).** Interaction events are _already_ source-agnostic:
`mesh_interaction` and the `pointer_*` family all spread
[`inputSourceShape`](../../oss/packages/schema/src/events/inputSource.ts)
(`source` / `handedness` / `sourceId` / optional world-space `ray`), `screen` is optional, and XR
actions route through `mesh_interaction` kinds (`select` / `squeeze` / `grab` / `release` /
`teleport`). ADR 0011 **deliberately deferred** the full rename to a generic `input_*` family as
"cleanest long-term, but mostly cosmetic for now."

**The actual remaining gaps** this work must close:

1. **`source` enum is missing `keyboard` and `gamepad`.** Today it is
   `mouse | touch | stylus | pen | xr-controller | hand | gaze | transient | other`.
2. **Keyboard is not a pointer/ray.** It has no `screen`, no `hitPoint`, no `ray` — it is a
   discrete _action_ (key/chord, optionally bound to a scene action like "rotate", "next camera").
   It does not fit `pointer_*` and shouldn't be crammed into it.
3. **Gamepad is dual-natured.** It acts both as a _pointer/ray_ (XR-style aim → fits the existing
   path) and as _continuous navigation_ (stick-driven camera, already covered by `camera_sample`).
   We must decide which gamepad inputs are interactions vs. pose.
4. **Reviving the deferred `input_*` model** (a generic, source-tagged interaction event) is now on
   the table again — but it supersedes three shipped events, so the trade-off must be re-decided.

**Proposed direction (specified in [ADR 0023](../adr/0023-input-action-and-keyboard-gamepad.md), which extends ADR 0011):**

- Add `keyboard` and `gamepad` to `inputSourceSchema` (additive, non-breaking).
- Add a **new** `input_action` event for _non-pointer, non-ray_ discrete inputs (keyboard chords,
  gamepad buttons bound to scene actions): `action` (string), optional `code`/`button`, plus
  `inputSourceShape`. This is the missing shape — pointer/ray inputs keep flowing through
  `pointer_*` / `mesh_interaction`.
- Keep gamepad _aim_ on the ray path and gamepad _navigation_ on `camera_sample`.
- Re-evaluate (and record the decision on) whether to also introduce the umbrella `input_*` rename
  or keep `pointer_*` as the flat-screen path per ADR 0011 §6.

Because this changes the interaction ontology and is hard to reverse, it is decided in
[ADR 0023](../adr/0023-input-action-and-keyboard-gamepad.md) (Proposed) before any schema/SDK code —
unlike the §A–F metrics, which mostly graduate straight to `add-event-type` issues.

---

## Priority order (recommended)

1. **§A `mesh_visibility`** — biggest differentiator, no good server-side workaround. _(shipped)_
2. **§B scene coverage + camera distance** — high value, _derivable_, zero client cost. _(shipped)_
3. **§C jank / frame-time percentiles + render resolution + `asset_load` TTI** — fixes the real
   blind spots in `frame_perf`. _(shipped)_
4. **§A `mesh_visibility` bounding-box ride-along** — extends the shipped dwell event for cheap;
   unlocks the ghost-scene reconstruction in the dashboard, reusing the bounds already read for
   `maxScreenFraction`.
5. **§D dead clicks / rage clicks / `hover_dwell`** — cheap; the hit-test already exists and dwell
   bucketing is proven by §A.
6. **§G input generalization (ADR first)** — keyboard/gamepad + `input_action`.
7. **§C compile stalls / memory (`resource_sample`)**, then **§E `capability_change`**, then
   **§F XR comfort** (XR-gated).

## Graduating an item to work

1. Open a GitHub Issue per row, label `event-type` (new shapes) or `enhancement` (derived/extend),
   milestone **"Metrics expansion"**, body linking to its §here.
2. New event shapes follow the [`add-event-type`](../../.github/skills/add-event-type) flow:
   Zod schema → `sdk-core` / `sdk-babylon` emit → collector ingest → replay handler → tests →
   `docs/integration.md`.
3. Derived metrics are dashboard/query/rollup issues — no schema change.
4. §G is specified in [ADR 0023](../adr/0023-input-action-and-keyboard-gamepad.md) (ratify before code).

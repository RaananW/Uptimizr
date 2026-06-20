# ADR 0025: Typed camera-gesture events — separating navigation intent from selection

- **Status:** Accepted
- **Date:** 2026-06-18
- **Deciders:** RaananW, engineering

## Context

In 3D scenes the same pointer gesture (`down → move → up`) is overloaded: it can **select an
object** _or_ **drive the camera** (orbit / pan / zoom). With the common orbit-style controls, a
drag that swings the view also happens to pass over whatever mesh sat under the cursor. Today the
Babylon connector ([`collector.ts`](../../oss/packages/sdk-babylon/src/collector.ts)) emits a
`pointer_click` on Babylon `POINTERTAP` and a `mesh_interaction { kind: "pick" }` on `POINTERPICK`,
both carrying whatever mesh the ray hit. That conflates two distinct user intents on one channel:

1. **Selection** — "I want _this object_." (object-engagement metric)
2. **Navigation** — "I want to _change my view_." (exploration metric)

Consequences of the conflation: click/selection heatmaps are **contaminated** by orbit-drags
(a mesh gets "selected" credit for merely being under the cursor during a view swing), and there is
no first-class signal for _how_ users navigate (do they orbit but never zoom in on a product?).

Babylon already suppresses `POINTERTAP` past a fixed ~10px `DragMovementThreshold`, so clicks are
_somewhat_ drag-filtered — but that threshold is spatial-only, fixed, and **blind to camera
motion**: a controlled orbit can stay within 10px while swinging the camera substantially.

### Forces

- **The discriminator is intent, not motion.** The question is not "did the camera move" — a
  follow-cam, an animation, or XR head-look all move the camera without any user _act_. The question
  is "**did the user perform a gesture that drove the camera**." That requires an **input bracket**
  (`down → up`, touch, XR thumbstick/grab — an action with a beginning, an end, an agent, and an
  [input source, ADR 0011](./0011-input-source-agnostic-events.md)).
- **Two kinds of camera motion must not be conflated.** _Camera pose_ is continuous ambient state
  (`camera_sample`, [ADR 0012](./0012-sampling-and-fidelity.md)); a _navigation gesture_ is a
  discrete, user-initiated event. XR head movement and follow-cams produce the former and **must
  not** emit the latter, or every XR session would spam navigation events.
- **The mesh under the cursor during a camera move is noise.** A navigation gesture is _not_ about
  an object; attaching a `mesh` to it would invent a new data-quality bug (attributing navigation to
  an arbitrary mesh), so the navigation event carries **no mesh**.
- **Replay-completeness** ([ADR 0015](./0015-replay-ndjson-streaming.md)): the raw
  `pointer_*` / `camera_sample` stream must stay intact. A gesture event is a _derived summary_, not
  a replacement.
- **Classify where the data is.** The exact camera pose at the `down` and `up` instants — and the
  camera's intrinsic parameters (`alpha`/`beta`/`radius`/`target` for an arc-rotate camera) — are
  only precisely available **client-side, in the connector**. `camera_sample` is throttled and
  idle-suppressed, so downstream reconstruction cannot reliably recover either the bracket (intent)
  or a fast flick's exact endpoints.
- **Open-core boundary** ([ADR 0020](./0020-open-core-storage-boundary.md)): the OSS/hosted line is
  about **storage and scale**, not about withholding cheap analytical correctness. Classifying a
  gesture costs ~tens of FLOPs **once per gesture** (snapshot scalars at `down`, diff at `up`) — far
  below the existing throttled pointer/camera work — so it belongs in the OSS connector, available
  to every self-hoster.

## Decision

Add a new, additive, **client-classified** `camera_gesture` event to `@uptimizr/schema`, emitted by
connectors, that records a discrete user-initiated viewpoint change bracketed by an input gesture.

### 1. The event (OSS, Phase 1)

`camera_gesture` — a discrete navigation gesture. Payload:

- `kind` — enum `orbit | pan | dolly | zoom | roll | fly | navigate`. The **dominant** motion of the
  gesture (definitions below). `navigate` is the **graceful fallback**: "the camera moved under a
  user bracket, but the camera type was unknown / could not be typed."
- `durationMs: number` — length of the input bracket (`down → up`). A cheap friction signal (long
  fiddly gestures suggest disorientation).
- `orbitDeg?: number` — angular sweep around the pivot, in degrees (naturally scale-free).
- `rollDeg?: number` — rotation about the view/forward axis, in degrees (naturally scale-free).
- `zoomRatio?: number` — ratio of the gesture's magnification change. For **dolly** it is
  `startDistance / endDistance` (camera moved along forward); for **zoom** it is the fov ratio
  `startFov / endFov` (lens magnification, camera stationary). Scale-free by construction; `> 1` =
  magnified / moved in, `< 1` = widened / pulled back. `kind` disambiguates which mechanism produced
  it.
- `panDist?: number` — lateral translation, **normalized by the camera-to-pivot distance at gesture
  start** (perceptual, self-contained, scale-free). For pivot-less cameras (e.g. a free/fly camera)
  this falls back to a fraction of scene radius; when neither is available the field is omitted and
  `kind` degrades toward `navigate`.
- `...inputSourceShape` — reused verbatim ([ADR 0011](./0011-input-source-agnostic-events.md)):
  `source` / `handedness` / `sourceId` / optional `ray`. A mouse orbit, a one-finger touch swing,
  and an XR thumbstick fly all land in this one event, distinguished by `source`.

**Deliberately absent:** `mesh`, `hitPoint`. A navigation gesture is not about an object — that
absence _is_ the data-quality fix.

#### Gesture-kind definitions

| `kind`     | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                             | Primary magnitude       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `orbit`    | Angular sweep of the camera **around its pivot/target**.                                                                                                                                                                                                                                                                                                                                                                                            | `orbitDeg`              |
| `pan`      | **Lateral** translation of camera + pivot (the framing slides).                                                                                                                                                                                                                                                                                                                                                                                     | `panDist`               |
| `dolly`    | Camera **physically moves along its forward axis** (parallax changes).                                                                                                                                                                                                                                                                                                                                                                              | `zoomRatio` (distance)  |
| `zoom`     | **Fov change**, camera stationary (lens magnification; no parallax).                                                                                                                                                                                                                                                                                                                                                                                | `zoomRatio` (fov)       |
| `roll`     | Rotation **about the view/forward axis** (horizon tilts).                                                                                                                                                                                                                                                                                                                                                                                           | `rollDeg`               |
| `fly`      | User-initiated **translation of the viewpoint through space** not driven by orbit/pan/dolly — XR thumbstick locomotion **and** XR teleport (the discrete viewpoint jump). Distinct from `mesh_interaction { kind: "teleport" }`, which is the _target pick_ (the selection act); `fly` is the _resulting viewpoint move_. A single teleport may emit **both** (a `teleport` mesh-interaction for the target + a `fly` camera-gesture for the jump). | `panDist` (translation) |
| `navigate` | The camera moved under a user bracket but the camera type was unknown / untypable (fallback).                                                                                                                                                                                                                                                                                                                                                       | —                       |

`dolly` vs `zoom` are kept distinct because they are perceptually different (a dolly moves _through_
the scene and changes parallax; a zoom magnifies _from afar_ and changes perspective distortion).
They are cheap to separate — `dolly` reads a distance/`radius` delta, `zoom` reads an `fov` delta —
so the connector reports the actual mechanism rather than collapsing both into one bucket.

### 2. Multi-component magnitudes, dominant `kind`

A single gesture can be **compound** (orbit + slight zoom on a trackpad). The event stores the
magnitudes for **every** axis that moved (`orbitDeg` / `rollDeg` / `zoomRatio` / `panDist`) and sets
`kind` to
the **dominant** one for easy `GROUP BY kind` queries. The magnitudes are already computed in order
to pick the dominant axis, so retaining them is nearly free, gives honest data (no secondary motion
erased), and avoids re-instrumenting later to answer "how far do people actually zoom?"

### 3. The motion dead-zone (click vs. navigate)

A motion dead-zone defines "moved at all," below which the gesture is treated as a click/select, not
navigation — e.g. orbit/roll > ~1°, `zoomRatio` outside ~[0.98, 1.02], pan > ~0.5% of the
normalization unit. Exposed as a **single sensitivity dial** that scales all axes together (tunable
via connector options, sane default); it reuses the same "signal vs. noise" instinct as camera
idle-suppression ([ADR 0012](./0012-sampling-and-fidelity.md)). A single dial is sufficient for v1:
**per-axis** thresholds would only matter to reject one noisy axis on a specific device (e.g. a
trackpad leaking spurious zoom while orbiting) without desensitizing the others — a narrow
per-device calibration case kept as a possible future escape hatch, not v1 surface.

### 4. The three-way (really four-way) classification

- **camera still + mesh hit** → `mesh_interaction` (selection) — clean by default.
- **camera still + object moved** (gizmo/manipulation) → `mesh_interaction { kind: "drag" }` — the
  already-defined-but-never-emitted `drag` kind finally gets its genuine use.
- **input bracket + camera moved** → `camera_gesture` (navigation; mesh discarded).
- **camera moved, no input bracket** (XR head-look, follow-cam, animation, post-release inertia
  coast) → **nothing new; just `camera_sample`**. The gesture ends at `up`; the inertia tail is
  post-gesture pose, not part of the event.

### 5. The per-camera-reader contract (engine surface)

The only engine-specific code is a thin `snapshot()` per **camera type** (not per engine) returning
the camera's intrinsics (orbit angles + pivot + distance when available, always position +
orientation + optional fov). The **classifier above it is shared and engine-agnostic**: it diffs two
snapshots into `{ kind, orbitDeg?, rollDeg?, zoomRatio?, panDist? }`.

- Babylon `ArcRotateCamera` / three `OrbitControls` → fully typed (`alpha`/`beta`/`radius`/`target`
  resp. azimuthal/polar/`getDistance()`/`target`).
- Free/fly cameras (no pivot) → decompose pose delta into lateral vs. along-forward translation +
  rotation.
- **Unknown camera** → `snapshot()` returns position + orientation only; the classifier still
  detects moved-vs-not and emits `kind: "navigate"`. **Degrades, never breaks.**

### 6. Storage, privacy, replay

`camera_gesture` ingests through the generic engine-neutral path. It carries no PII and no mesh — a
low-cardinality `kind`, a few numeric magnitudes, a duration, and the standard input-source fields.
Raw `pointer_*` and `camera_sample` are unchanged, so replay stays complete; replay treats
`camera_gesture` as a derived annotation, reconstructing the actual trajectory from `camera_sample`
during the bracket.

## Phase 2 (hosted) — out of scope for this ADR's implementation

The following depend on cross-session storage and compute and belong to the hosted product
([ADR 0020](./0020-open-core-storage-boundary.md)); they **consume** the OSS `camera_gesture` event
and must not be built into the OSS connector during Phase 1
([phases](../phases/)):

- **Cross-session navigation analytics** — navigation funnels, "users orbit but never zoom in on
  product X," disorientation/friction detection, pivot-point clustering, sessionized exploration
  paths.
- **Unknown-camera typing enrichment** — for `kind: "navigate"` (untyped) gestures, infer a probable
  `orbit`/`pan`/`zoom` type server-side from the `camera_sample` trajectory captured during the
  bracket. This is the legitimate hosted value-add precisely _because_ client-side intrinsic params
  were unavailable; it is a noisier transform-inference approximation, never a replacement for the
  client classification.

This split keeps the OSS product **correct by default** (clean heatmaps, typed gestures for known
cameras — all for ~tens of FLOPs per gesture) while reserving the genuinely scale-dependent
interpretation layer for hosted.

## Consequences

### Positive

- Click/selection heatmaps are **clean by default**: orbit-drags no longer inflate mesh engagement,
  because navigation is a separate event with no mesh.
- Navigation becomes a **first-class, typed, source-agnostic** signal (orbit/pan/zoom/fly) usable
  across mouse, touch, and XR via the shared `inputSourceShape`.
- The dead `mesh_interaction { kind: "drag" }` kind gets its correct, narrow use (object
  manipulation), distinct from navigation.
- Intent (the input bracket) is captured where it is actually knowable — the client — and cannot be
  faithfully reconstructed downstream, so this is the _only_ place it can live accurately.
- Fully additive: a new event + a new optional reader per camera type; no existing event, column, or
  SDK call site changes. Historical rows simply lack the event (graceful unknown).

### Negative / trade-offs

- `panDist` normalization is camera-dependent (camera-to-pivot distance, with a scene-radius
  fallback); pivot-less cameras yield a less comparable pan magnitude, reflected by omitting the
  field / degrading to `navigate`.
- Compound gestures collapse to a single dominant `kind` for grouping (magnitudes preserve the
  secondary motion, but the headline `kind` is lossy by design).
- Each connector must add per-camera-type readers to get _typed_ gestures; until then a connector
  emits untyped `kind: "navigate"`, so typing quality varies by connector maturity.
- One more event type to thread through schema, heatmap drivers, query, and replay across all
  connectors — the standard "events live once" coordination cost.

## Alternatives considered

- **Annotate the existing `pointer_click` with a `cameraMoved` flag** (instead of a new event) —
  smaller and back-compatible, but leaves the _default_ aggregation wrong: every naive
  `COUNT(pointer_click)` silently includes orbit-drags unless the consumer remembers to filter.
  Encoding intent in the taxonomy (a distinct event) is correct-by-default; rejected in favor of a
  first-class event.
- **Reclassify camera-move gestures as `mesh_interaction { kind: "drag" }`** — would attach a
  meaningless mesh to a navigation gesture (the mesh under the cursor is noise), inventing a new
  data-quality bug; rejected. `drag` is reserved for true object manipulation (camera still).
- **Gate emission: only emit clicks when the camera was still, drop the rest** — cleanest heatmaps
  but _hides_ data and loses the ambiguous-gesture cases; violates replay-completeness; rejected.
  Classify, don't drop.
- **Reconstruct gestures server-side from `camera_sample`** — cannot recover the input bracket
  (intent) and misses fast-flick endpoints (throttled/idle-suppressed samples); also ambiguous
  between orbit and pan-without-pivot. Acceptable only as a hosted _enrichment_ for unknown cameras,
  not as the primary path; rejected as the OSS mechanism.
- **Treat all camera motion as navigation events** — would spam events for XR head-look,
  follow-cams, and animations, which are pose, not user gestures; rejected. The input bracket is the
  required discriminator.
- **Screen-pixel-delta typing** ("left-drag = orbit, right-drag = pan") — a guess about input
  binding that breaks under custom/inverted control schemes and touch pinch-vs-pan; rejected in
  favor of reading the camera's intrinsic parameters.

## Resolved decisions

These were open during drafting and are now decided (recorded here for provenance):

1. **Gesture-kind vocabulary** — **`dolly` and `roll` are included** as distinct kinds (final set:
   `orbit | pan | dolly | zoom | roll | fly | navigate`). Separating `dolly` (distance delta) from
   `zoom` (fov delta) is a one-property-read cost for a real perceptual distinction; `roll` is a
   small extra decomposition that matters for flight/space/medical cameras. See the gesture-kind
   definitions table in §1.
2. **Pan normalization** — **camera-to-pivot distance** is the chosen unit (scene-radius fallback
   for pivot-less cameras). It is perceptual: a "half-screen" pan reports the same value near or
   far, because screen displacement ≈ world displacement ÷ distance-to-subject. Scene-radius
   normalization was rejected as the primary unit — when zoomed close in a large scene it reports
   identical-feeling pans as wildly different fractions.
3. **Dead-zone** — a **single sensitivity dial** scaling all axes (not per-axis). Per-axis is
   retained only as a possible future escape hatch for a device that leaks jitter on one axis (e.g.
   trackpad zoom-while-orbiting); it is not v1 surface.
4. **XR locomotion → `fly`** — thumbstick locomotion **and** teleport both emit
   `camera_gesture { kind: "fly" }` (the viewpoint translation). This is distinct from
   `mesh_interaction { kind: "teleport" }`, which records the _target pick_ (the selection act); a
   single teleport may emit both. See the `fly` row of the gesture-kind table in §1.

## Open questions

1. **Pivot-less pan fallback precision** — confirm the scene-radius fallback is acceptable for
   free/fly cameras, or whether such pans should be omitted entirely (`kind` → `navigate`) rather
   than reported in a less-comparable unit.
2. **Dead-zone defaults** — validate the proposed epsilons (orbit/roll 1°, ±2% zoom, 0.5% pan)
   against real sessions and tune the single dial's default.

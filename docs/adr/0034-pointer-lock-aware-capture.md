# ADR 0034: Pointer-lock-aware pointer capture (crosshair = viewport centre)

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** RaananW, engineering

## Context

First-person / walkable scenes ([ADR 0026](./0026-camera-mode-aware-analytics.md)) navigate with
the browser **Pointer Lock API**: three.js `PointerLockControls`, PlayCanvas
`Mouse.enablePointerLock()`, or Babylon's `engine.enterPointerlock()`. While the pointer is locked
the OS cursor is hidden and mouse motion is delivered only as `movementX` / `movementY` deltas that
the controls consume to turn the camera. Crucially, the **absolute** cursor position stops updating:
`MouseEvent.clientX/Y` and Babylon's `scene.pointerX/Y` **freeze** at the coordinate where lock was
engaged.

Every 2D-pointer path in the connectors derives its normalized `screen` coordinate (and the pick
ray) from that absolute position:

- three — `screen = (clientX − rect.left) / width` (`screenOf` in `sdk-three`).
- PlayCanvas — the same `screenOf` formula in `sdk-playcanvas`.
- Babylon — `screen = scene.pointerX / engine.getRenderWidth()` in `sdk-babylon`.

So under pointer lock the captured signal is **wrong**, not merely sparse:

1. `pointer_move` either stops firing or pins to one stale point.
2. `pointer_click` / `pointer_down` / `pointer_up` record the **stale** coordinate — wherever the
   visitor first clicked to grab the lock — so the 2D pointer/click heatmap collapses to a single
   misleading dot.
3. Picking raycasts from that stale point instead of the crosshair, so `hitMesh` / `hitPoint` can be
   wrong — clicking an exhibit may pick nothing or the wrong object.

This first bites with the playground's walkable `gallery` scene (real glTF exhibits on three /
PlayCanvas), but it is a connector-level capture bug, independent of the playground.

### Forces

- **The crosshair _is_ the pointer in a locked view.** A locked first-person camera aims at the
  fixed **viewport centre**; that is the only honest 2D position for a click while locked.
- **Don't reinvent the spatial story.** First-person attention is already answered by the
  **world-space gaze heatmap** ([ADR 0030](./0030-world-space-gaze-heatmap.md), a camera-forward
  raycast driven by `camera_sample`) and **floor-plan / trajectory** ([ADR 0026], driven by
  `camera_sample` positions). All three are cursor-independent and keep working while locked. The
  2D pointer heatmap is a secondary lens here; it just must not lie.
- **No new event, no schema change.** `pointer_move` / `pointer_click` already carry `screen` +
  optional `hitPoint` / `hitMesh`. The fix is _what value_ the connector puts in `screen` while
  locked, not a new shape — honouring "events live once" ([AGENTS.md](../../AGENTS.md)).
- **Detection must be environment-safe.** The check reads `document.pointerLockElement`; it has to
  no-op in headless / SSR (no `document`) and never touch engine canvas APIs unless a lock is
  actually held.

## Decision

Make the connectors **pointer-lock-aware**. When the rendering canvas currently holds the pointer
lock (`document.pointerLockElement === canvas`), treat the pointer as the **viewport centre**:

- `pointer_move` / `pointer_down` / `pointer_up` / `pointer_click` emit `screen = [0.5, 0.5]`.
- Picking raycasts from NDC `(0, 0)` (the crosshair), so `hitMesh` / `hitPoint` describe the aim
  point.
- `pointer_move` keeps streaming while locked (pinned to centre) rather than being suppressed, so
  the move cadence and the 2D heatmap stay continuous — a tight centre cluster correctly reads as
  "FPS aiming," while gaze + floor-plan carry the real spatial behaviour.

Implementation is a single shared seam per connector:

- **three / PlayCanvas** — `screenOf()` returns `[0.5, 0.5]` when locked; the existing
  `pickAt(screen)` then raycasts from centre automatically.
- **Babylon** — the `onPointerObservable` handler overrides `screen` to `[0.5, 0.5]` and re-picks at
  the render-target centre (`scene.pick(width/2, height/2)`) instead of using Babylon's
  cursor-position `info.pickInfo`.

The lock check is a small package-local helper guarded by `typeof document !== "undefined"` that
only reads the engine canvas when a lock is actually held, so headless capture and the existing unit
tests are unaffected.

## Consequences

### Positive

- Clicks and the 2D pointer/click heatmap are correct (centred) in locked first-person scenes
  instead of pinned to a stale cursor.
- Picking under lock hits the crosshair target, so `hitMesh` / `mesh_interaction` reflect what the
  visitor actually aimed at.
- No schema, event, or storage change; replay and aggregations are untouched.

### Negative / trade-offs

- While locked, the 2D pointer heatmap degenerates to a centre cluster (by design). The richer
  first-person signal lives in the gaze/world heatmap and floor-plan/trajectory panels, not the 2D
  pointer heatmap.
- Babylon re-picks at centre per pointer event while locked (a CPU raycast), marginally more work
  than reading `info.pickInfo`; it only runs while a lock is held and is dwarfed by camera-turn
  cost.

## Alternatives considered

- **Suppress `pointer_move` while locked** (emit nothing, rely on gaze) — rejected: it leaves a gap
  in the move stream and still needs the centre fix for clicks, so it is strictly more behaviour for
  less data.
- **Integrate `movementX/Y` deltas into a virtual cursor** — rejected: a locked camera has no
  meaningful 2D cursor; the deltas are _camera rotation_, already captured as `camera_sample` /
  gaze. Reconstructing a fake cursor would invent a signal.
- **Fix only the playground gallery's `pickAt`** — rejected: the stale-coordinate bug is in the
  published connectors' capture path, so every locked first-person integration would hit it.

# @uptimizr/playcanvas

The PlayCanvas connector for Uptimizr. It registers as an
[`@uptimizr/sdk-core`](../sdk-core) **collector** and captures:

- **camera pose** (position + forward direction) → view-direction heatmap
- **pointer move / click** (normalized screen + optional raycast hit) → screen heatmaps
- **mesh picks** → object-engagement analytics
- **FPS** → performance
- **mesh visibility** (opt-in) → per-object dwell / attention, with an optional world AABB
- **hover dwell** (opt-in) → hover hesitation (lingering without acting)

`playcanvas` is a **peer dependency**: the connector reads from the host
application's PlayCanvas instance and never bundles or mutates the scene. It tears
down all DOM listeners, timers, and `frameend` handlers on stop. World-space data
is normalized from PlayCanvas' native **right-handed, y-up** frame to the canonical
wire frame (**left-handed, y-up**) at the emission boundary.

## Install

```bash
npm install @uptimizr/playcanvas playcanvas
```

`playcanvas` is a **peer dependency** — the connector reads your existing
PlayCanvas instance and never bundles its own.

## Usage

The quickest integration is a single call. Because PlayCanvas supports multiple
camera entities with no single "active" camera, and the connector reads FPS and the
canvas from `app.graphicsDevice`, the `camera` Entity is an explicit argument:

```ts
import { trackScene } from "@uptimizr/playcanvas";

const client = trackScene(app, cameraEntity, {
  projectId: "your-project",
  endpoint: "https://collect.example.com",
});

// ... later, on teardown
await client.stop("manual");
```

`trackScene` creates the client, registers the collector, reads device/GPU caps,
and starts the session. It returns the [`@uptimizr/sdk-core`](../sdk-core)
`UptimizrClient`, so you can read `client.sessionId`, emit custom events, or stop it.

### Advanced: wire it up yourself

For a custom transport, a `beforeSend` hook, or registering multiple collectors,
compose the pieces directly:

```ts
import { UptimizrClient } from "@uptimizr/sdk-core";
import { playcanvasCollector, readDeviceCaps } from "@uptimizr/playcanvas";

const client = new UptimizrClient({
  projectId: "your-project",
  endpoint: "https://collect.example.com",
});

client.use(playcanvasCollector({ app, camera: cameraEntity }));

// device/GPU caps ride along on session_start
client.start({ device: readDeviceCaps(app) });

// ... later, on teardown
client.stop("manual");
```

### Options

Both `trackScene` and `playcanvasCollector` accept the same sampling/capture knobs
as the Babylon and three connectors:

```ts
playcanvasCollector({
  app,
  camera: cameraEntity,
  sampleCameraMs: 1000, // camera-pose sampling interval
  samplePerfMs: 2000, // FPS sampling interval (read from app.stats.frame.fps)
  pointerMoveThrottleMs: 250, // min gap between pointer_move samples
  capture: { camera: true, pointerMove: true, clicks: true, meshPicks: true, perf: true },
});
```

### Capture fidelity

The `sampling` profile sets the per-channel fidelity dial in **Hz** (`0` = off,
`"frame"` = every render tick). It governs continuous channels only — camera pose,
pointer move, and perf; discrete events (clicks, picks, custom) are always
captured. `"frame"`-cadence channels are driven by the engine's own `frameend`
event (the app's render tick), which the connector subscribes to and removes on
stop.

```ts
playcanvasCollector({ app, camera, sampling: { camera: 10, pointerMove: 60, perf: 0.5 } });
```

### Opt-in dwell capture (mesh_visibility #37, hover_dwell #48)

Two attention signals are **off by default** (privacy) and emit one
bucketed summary per window/episode:

- **`mesh_visibility`** — per-object on-screen time, time near the view centre (a
  gaze proxy), and the max screen fraction reached. Enable `capture.meshVisibility`
  and tune via `meshVisibility`. With `boundingBox: true` it rides each object's
  world AABB along (#53) so the dashboard can draw a coarse scene "ghost"; the box
  is sent once and only re-sent when it moves. The connector unions each entity's
  per-`MeshInstance` **world** AABB directly (PlayCanvas exposes `meshInstance.aabb`
  in world space) and uses a forward half-space visibility test — **import-free**.
- **`hover_dwell`** — fires when the pointer rests on an object for at least
  `minDwellMs` _without clicking it_ (a click is engagement, not hesitation).
  Enable `capture.hoverDwell` and tune via `hoverDwell`.

```ts
playcanvasCollector({
  app,
  camera,
  capture: { meshVisibility: true, hoverDwell: true },
  meshVisibility: { windowMs: 5000, boundingBox: true, centeredAngleDeg: 12, maxMeshes: 50 },
  hoverDwell: { minDwellMs: 500 },
});
```

### Scene proxy (spatial heatmap backdrop)

`scanSceneProxy(app, { sceneId })` walks the scene graph and produces an
engine-agnostic, per-object **world AABB** proxy (already normalized to the
canonical frame) so a world-space heatmap has a faint spatial backdrop without
shipping the host's real assets. PlayCanvas hands back each `MeshInstance`'s world
AABB directly, so the proxy is a straight min/max union per named entity.

## PlayCanvas adaptations

PlayCanvas differs from Babylon and three in a few places; each is handled at the
connector boundary so the emitted events are identical:

- **Camera forward:** a PlayCanvas `Entity.forward` getter already returns the
  **true world-space** look direction (unlike three cameras, which look along local
  **−Z**), so it converts straight through the canonical Z-negation — no extra
  per-camera negation.
- **Pointer/raycast:** PlayCanvas has no pointer observable, so DOM listeners are
  attached to `app.graphicsDevice.canvas` and hits are resolved with a `pc.Ray`
  against the scene's mesh-instance world AABBs (`BoundingBox.intersectsRay`). The
  pick is **physics-free** — it never touches the rigidbody system, so the
  connector adds no `ammo` dependency.
- **FPS:** read directly from `app.stats.frame.fps` (PlayCanvas computes it), so —
  unlike three — there is no frame-counter delta.
- **"frame" cadence:** the connector owns no animation loop; it subscribes to the
  engine's `frameend` event (the app's own render tick) and removes it on stop, so
  dwell accumulation pauses when the tab is hidden (matching Babylon's
  `onBeforeRender`).
- **Mesh visibility:** the connector unions each entity's `meshInstance.aabb`
  (already world-space) into one box and uses a **forward half-space** test for
  visibility, rather than a full VP-matrix frustum (PlayCanvas doesn't expose flat
  projection/view matrices structurally without importing the engine). Anything in
  front of the camera counts — the documented divergence from three's clip-space
  frustum path.
- **Coordinate frame:** fixed right-handed, y-up (PlayCanvas has no per-scene
  handedness flag like Babylon's `useRightHandedSystem`).
- **`asset_load`:** **not captured.** Mirrors the three connector — the connector
  does not hook PlayCanvas' asset registry; report load timing from your app via
  `client.track(...)` if needed. (Follow-up: a first-class asset-load hook.)
- **Compile stalls (`compile_stall`, #42):** **not captured.** Babylon exposes
  engine-level shader-compilation observables the connector can time; PlayCanvas has
  no equivalent public compile hook, so compile-stall capture is Babylon-only for now.
- **Resource footprint (`resource_sample`, #44):** captured, but with **fewer
  metrics** than Babylon. `app.stats.frame.triangles` gives the `triangles`
  submitted last frame; there is no public per-frame vertex count, and resident
  texture/geometry bytes aren't exposed, so those fields are omitted (the read
  API's averages skip unreported metrics). `jsHeapBytes` comes from the
  Chromium-only `performance.memory`. Opt-in (`capture.resourceSample`), low-rate,
  and read-only like the rest.
- **Capability changes (`capability_change`, #49):** **not auto-captured — by
  design.** A WebGPU→WebGL2 downgrade or a re-init after a lost device is an
  _app/engine decision_ with no reliable runtime hook the connector could observe
  (PlayCanvas picks its backend at device creation). Report these transitions from
  your app with the engine-neutral
  `client.reportCapabilityChange({ kind, from?, to?, reason? })` (sdk-core). The
  raw GPU lifecycle (`context_lost` / `context_restored`) is still captured by the
  connector; `capability_change` is the higher-level companion.

## License

[Apache-2.0](./LICENSE) © Uptimizr.

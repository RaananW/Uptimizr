# @uptimizr/three

The three.js connector for Uptimizr. It registers as an
[`@uptimizr/sdk-core`](../sdk-core) **collector** and captures:

- **camera pose** (position + forward direction) → view-direction heatmap
- **pointer move / click** (normalized screen + optional raycast hit) → screen heatmaps
- **mesh picks** → object-engagement analytics
- **FPS** → performance
- **mesh visibility** (opt-in) → per-object dwell / attention, with an optional world AABB
- **hover dwell** (opt-in) → hover hesitation (lingering without acting)

`three` is a **peer dependency**: the connector reads from the host application's
three.js instance and never bundles or mutates the scene. It tears down all DOM
listeners, timers, and animation-frame callbacks on stop. World-space data is
normalized from three's native **right-handed, y-up** frame to the canonical wire
frame (**left-handed, y-up**) at the emission boundary.

## Install

```bash
npm install @uptimizr/three three
```

`three` is a **peer dependency** — the connector reads your existing three.js
instance and never bundles its own.

## Usage

The quickest integration is a single call. Because three.js has no
`scene.activeCamera` and the connector reads FPS and the canvas from the renderer,
`camera` and `renderer` are explicit arguments:

```ts
import { trackScene } from "@uptimizr/three";

const client = trackScene(scene, camera, renderer, {
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
import { threeCollector, readDeviceCaps } from "@uptimizr/three";

const client = new UptimizrClient({
  projectId: "your-project",
  endpoint: "https://collect.example.com",
});

client.use(threeCollector({ scene, camera, renderer }));

// device/GPU caps ride along on session_start
client.start({ device: readDeviceCaps(renderer) });

// ... later, on teardown
client.stop("manual");
```

### Options

Both `trackScene` and `threeCollector` accept the same sampling/capture knobs as
the Babylon connector:

```ts
threeCollector({
  scene,
  camera,
  renderer,
  sampleCameraMs: 1000, // camera-pose sampling interval
  samplePerfMs: 2000, // FPS sampling interval (derived from renderer.info)
  pointerMoveThrottleMs: 250, // min gap between pointer_move samples
  capture: { camera: true, pointerMove: true, clicks: true, meshPicks: true, perf: true },
});
```

### Capture fidelity

The `sampling` profile sets the per-channel fidelity dial in **Hz** (`0` = off,
`"frame"` = every render tick). It governs continuous channels only — camera pose,
pointer move, and perf; discrete events (clicks, picks, custom) are always
captured. `"frame"`-cadence channels are driven by `requestAnimationFrame`
(rAF ≈ render cadence), since three exposes no per-frame hook the connector owns.

```ts
threeCollector({ scene, camera, renderer, sampling: { camera: 10, pointerMove: 60, perf: 0.5 } });
```

### Opt-in dwell capture (mesh_visibility #37, hover_dwell #48)

Two attention signals are **off by default** (privacy) and emit one
bucketed summary per window/episode:

- **`mesh_visibility`** — per-object on-screen time, time near the view centre (a
  gaze proxy), and the max screen fraction reached. Enable `capture.meshVisibility`
  and tune via `meshVisibility`. With `boundingBox: true` it rides each object's
  world AABB along (#53) so the dashboard can draw a coarse scene "ghost"; the box
  is sent once and only re-sent when it moves. three has no `mesh.isInFrustum` or
  world-AABB reader (Babylon does), so the connector computes both **import-free**
  from `geometry.boundingBox` + `matrixWorld` and a clip-space frustum test.
- **`hover_dwell`** — fires when the pointer rests on an object for at least
  `minDwellMs` _without clicking it_ (a click is engagement, not hesitation).
  Enable `capture.hoverDwell` and tune via `hoverDwell`.

```ts
threeCollector({
  scene,
  camera,
  renderer,
  capture: { meshVisibility: true, hoverDwell: true },
  meshVisibility: { windowMs: 5000, boundingBox: true, centeredAngleDeg: 12, maxMeshes: 50 },
  hoverDwell: { minDwellMs: 500 },
});
```

## three.js adaptations

three.js differs from Babylon in a few places; each is handled at the connector
boundary so the emitted events are identical:

- **Camera forward:** three cameras look along local **−Z** (canonical looks along
  **+Z**). The connector reads the **true world-space** forward via
  `camera.getWorldDirection(...)` _before_ converting, so the canonical Z-negation
  is correct (it never reconstructs orientation from the local quaternion).
- **Pointer/raycast:** three has no pointer observable, so DOM listeners are
  attached to `renderer.domElement` and hits are resolved with `THREE.Raycaster`.
- **Pointer lock (ADR 0034):** when `renderer.domElement` holds the pointer lock
  (`PointerLockControls`, first-person/FPS scenes), the OS cursor freezes, so the
  connector reports `pointer_move`/`pointer_click` from the viewport centre
  (`screen = [0.5, 0.5]`) and raycasts from NDC `(0, 0)` — the crosshair. Read the
  spatial story from the gaze/floor-plan heatmaps, not the 2D pointer heatmap.
- **FPS:** derived from the `renderer.info.render.frame` delta over the sample
  interval (three has no `getFps()`).
- **Mesh visibility:** three has no `mesh.isInFrustum(...)` or
  `getBoundingInfo().boundingBox` with world min/max. The connector accumulates
  on-screen time once per `requestAnimationFrame` (so dwell pauses with the tab,
  matching Babylon's `onBeforeRender`), computes each object's world AABB from
  `geometry.boundingBox` + `matrixWorld`, and tests the view frustum from
  `projectionMatrix · matrixWorldInverse` — all without importing `three`.
- **Coordinate frame:** fixed right-handed, y-up (three has no per-scene handedness
  flag like Babylon's `useRightHandedSystem`).
- **Compile stalls (`compile_stall`, #42):** **not captured.** Babylon exposes an
  engine-level `onBeforeShaderCompilationObservable` / `onAfterShaderCompilationObservable`
  pair the connector can time; three's `WebGLRenderer` has no equivalent public
  compile hook and compiles lazily on first render, so there is no boundary the
  connector can measure without monkey-patching the renderer (which would violate
  the "never mutate the engine" rule). Compile-stall capture is therefore
  Babylon-only for now.
- **Resource footprint (`resource_sample`, #44):** captured, but with **fewer
  metrics** than Babylon. three's `renderer.info.render.triangles` gives the
  `triangles` submitted last frame; there is no public per-frame vertex count, and
  resident texture/geometry bytes aren't exposed, so those fields are omitted (the
  read API's averages skip unreported metrics). `jsHeapBytes` comes from the
  Chromium-only `performance.memory`. Opt-in (`capture.resourceSample`), low-rate,
  and read-only like the rest.
- **Capability changes (`capability_change`, #49):** **not auto-captured — by
  design.** A WebGPU→WebGL2 downgrade, a quality/LOD auto-downgrade, or a re-init
  after a lost device is an _app/engine decision_ with no reliable runtime hook
  the connector could observe (three picks its backend at construction). Report
  these transitions from your app with the engine-neutral
  `client.reportCapabilityChange({ kind, from?, to?, reason? })` (sdk-core). The
  raw GPU lifecycle (`context_lost` / `context_restored`) is still captured by the
  connector; `capability_change` is the higher-level companion.
- **Engine diagnostics — WebGPU `device.lost` (`graphics_diagnostic`, #20):**
  opt-in via `captureGraphicsDiagnostics: true` on the client (off by default). On a
  `WebGPURenderer`, the connector subscribes to `renderer.backend.device.lost` and
  emits one `graphics_diagnostic` with `category: "device-lost"` and
  `backend: "webgpu"` — `severity` is `info` for a requested loss
  (`reason: "destroyed"`) and `fatal` otherwise; the optional length-capped `message`
  runs through `beforeSend`. Engine-parity with the Babylon connector. A
  `WebGLRenderer` is a **no-op** (no device-lost concept; its interruption is the
  always-on `context_lost`).

## License

[Apache-2.0](./LICENSE) © Uptimizr.

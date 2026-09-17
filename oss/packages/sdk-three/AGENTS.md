# AGENTS.md — @uptimizr/three

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

The three.js connector for Uptimizr. It registers as an `@uptimizr/sdk-core` **collector** and
captures camera pose (view-direction heatmap), pointer move/click/button transitions (screen
heatmaps), camera gestures, mesh picks (object engagement), FPS and context loss (perf /
reliability), plus opt-in mesh visibility, hover dwell, world-space gaze, resource samples and
node transforms. `trackScene` also registers the WebXR collector by default.

`three` is a **peer dependency** — every three import is type-only (except the module constant
`REVISION`, read for connector provenance), so the connector reads the host application's scene
by duck typing and never bundles or mutates it. World-space data is normalized from three's
native **right-handed, y-up** frame to the canonical wire frame (**left-handed, y-up**) at the
emission boundary (ADR 0018).

## Install

```bash
pnpm add @uptimizr/three
# `three` is a peer dependency provided by your app.
```

## Canonical usage

three.js has no `scene.activeCamera`, and FPS and the canvas are read from the renderer, so
`camera` and `renderer` are explicit positional arguments (unlike Babylon's `trackScene(scene, …)`):

```ts
import { trackScene } from "@uptimizr/three";

const client = trackScene(scene, camera, renderer, {
  projectId: "your-project",
  endpoint: "https://collect.example.com",
});
// ... later, on teardown
await client.stop("manual");
```

`trackScene` returns the `@uptimizr/sdk-core` `UptimizrClient`, so you can read
`client.sessionId`, emit custom events with `client.track(name, props)`, switch scene with
`client.setScene(sceneId)`, and `client.stop(reason)` to tear everything down (there is no
separate `dispose()` — stopping the client removes every DOM listener, timer and rAF callback).

### Advanced (compose it yourself)

```ts
import { UptimizrClient } from "@uptimizr/sdk-core";
import { threeCollector, readDeviceCaps } from "@uptimizr/three";

const client = new UptimizrClient({
  projectId: "your-project",
  endpoint: "https://collect.example.com",
});
client.use(threeCollector({ scene, camera, renderer }));
client.start({ device: readDeviceCaps(renderer) });
```

Use `threeCollector` directly for collector-only tuning: `meshVisibility`, `hoverDwell`,
`resourceSample`, `raycast`, `cameraGestureSensitivity`.

## Capture knobs

`sampleCameraMs` (1000), `samplePerfMs` (2000), `pointerMoveThrottleMs` (250),
`suppressIdleSamples`, `suppressIdlePerfSamples`, `cameraEpsilon`, `perfFpsThreshold`, and a
`capture` toggle map (`ThreeCaptureOptions`). The `sampling` profile sets per-channel fidelity in
Hz (`0` = off, `"frame"` = every tick) for continuous channels only — camera, pointer move, perf
(ADR 0012). Discrete events (clicks, picks, custom) are always captured. `"frame"` cadence is
driven by `requestAnimationFrame`, since three exposes no per-frame hook the connector owns.

Other `TrackSceneOptions`: `gaze`, `actors` (+ `sampling.nodes`, ADR 0027), `keyBindings`
(ADR 0023 — **only bound keys** are ever recorded), `cameraType` (ADR 0026), `sceneDescription`,
`user`, `meta`, `connector`, `xr`, `flushIntervalMs`, `transport`, `disabled`, `debug`.

## Rules for agents

- Treat `three` as a peer dependency; keep three imports **type-only**.
- Emit only `@uptimizr/schema` events; do not redefine event shapes.
- Pointer/mesh events carry an input `source` (`mouse`/`touch`/`pen`/`xr-controller`/`hand`/
  `gaze`/`transient`, ADR 0011) — do not strip it.
- Privacy (ADR 0003): no cookies, no persistent client identifier. `keyBindings` is an allow-list,
  never a keylogger; `user.id` must be pseudonymous. Attention channels (`meshVisibility`,
  `hoverDwell`, `gaze`, `resourceSample`) are **off by default** — keep them opt-in.
- `registerRegions(sceneId, regions, { endpoint, apiKey })` (from `@uptimizr/sdk-core`) declares a
  scene's named regions. It **replaces** the scene's set and needs an **`annotate`**-capable key —
  never ship that key in a public bundle; call it from build/deploy/admin code.
- Not captured on three, by design: `compile_stall` (no public compile hook) and
  `capability_change` (report it yourself via `client.reportCapabilityChange(...)`).
  Don't monkey-patch the renderer to fake them.
- To support another engine, create a sibling package depending only on `@uptimizr/sdk-core` and
  `@uptimizr/schema`; see the repo `add-connector` skill.

## More

- Package reference: [README.md](./README.md)
- Connector guide: https://uptimizr.com/docs/connectors/three/
- Integration guide: https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md

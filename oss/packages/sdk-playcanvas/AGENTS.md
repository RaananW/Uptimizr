# AGENTS.md — @uptimizr/playcanvas

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

The PlayCanvas connector for Uptimizr. It registers as an `@uptimizr/sdk-core` **collector** and
captures camera pose (view-direction heatmap), pointer move/click/button transitions (screen
heatmaps), camera gestures, mesh picks (object engagement), FPS, context loss and asset-load
timing (perf / reliability), plus opt-in mesh visibility, hover dwell, world-space gaze, resource
samples and node transforms.

`playcanvas` is a **peer dependency** — the connector reads the host application's PlayCanvas
instance and never bundles or mutates it. World-space data is normalized from PlayCanvas' native
**right-handed, y-up** frame to the canonical wire frame (**left-handed, y-up**) at the emission
boundary (ADR 0018).

## Install

```bash
pnpm add @uptimizr/playcanvas
# `playcanvas` is a peer dependency provided by your app.
```

## Canonical usage

PlayCanvas supports multiple camera entities with no single "active" camera, and FPS and the
canvas come from `app.graphicsDevice`, so the camera `Entity` is an explicit argument:

```ts
import { trackScene } from "@uptimizr/playcanvas";

const client = trackScene(app, cameraEntity, {
  projectId: "your-project",
  endpoint: "https://collect.example.com",
});
// ... later, on teardown
await client.stop("manual");
```

`trackScene` returns the `@uptimizr/sdk-core` `UptimizrClient`, so you can read
`client.sessionId`, emit custom events with `client.track(name, props)`, switch scene with
`client.setScene(sceneId)`, and `client.stop(reason)` to tear everything down (there is no
separate `dispose()` — stopping the client removes every DOM listener, timer and `frameend`
handler).

### Advanced (compose it yourself)

```ts
import { UptimizrClient } from "@uptimizr/sdk-core";
import { playcanvasCollector, readDeviceCaps } from "@uptimizr/playcanvas";

const client = new UptimizrClient({
  projectId: "your-project",
  endpoint: "https://collect.example.com",
});
client.use(playcanvasCollector({ app, camera: cameraEntity }));
client.start({ device: readDeviceCaps(app) });
```

Use `playcanvasCollector` directly for collector-only tuning: `meshVisibility`, `hoverDwell`,
`resourceSample`, `raycast`, `cameraGestureSensitivity`.

## Capture knobs

`sampleCameraMs` (1000), `samplePerfMs` (2000), `pointerMoveThrottleMs` (250),
`suppressIdleSamples`, `suppressIdlePerfSamples`, `cameraEpsilon`, `perfFpsThreshold`, and a
`capture` toggle map (`PlayCanvasCaptureOptions`, including `assetLoad`, on by default). The
`sampling` profile sets per-channel fidelity in Hz (`0` = off, `"frame"` = every tick) for
continuous channels only — camera, pointer move, perf (ADR 0012). Discrete events (clicks, picks,
custom) are always captured. `"frame"` cadence rides the engine's own `frameend` event, which the
connector subscribes to and removes on stop.

Other `TrackSceneOptions`: `gaze`, `actors` (+ `sampling.nodes`, ADR 0027), `keyBindings`
(ADR 0023 — **only bound keys** are ever recorded), `cameraType` (ADR 0026), `sceneDescription`,
`user`, `meta`, `flushIntervalMs`, `transport`, `disabled`, `debug`.

## Rules for agents

- Treat `playcanvas` as a peer dependency; the connector reads the host's instance structurally.
- Emit only `@uptimizr/schema` events; do not redefine event shapes.
- Pointer/mesh events carry an input `source` (`mouse`/`touch`/`pen`, ADR 0011) — do not strip it.
- Privacy (ADR 0003): no cookies, no persistent client identifier. `asset_load` records the
  app-defined asset **name**, never the file URL. `keyBindings` is an allow-list, never a
  keylogger; `user.id` must be pseudonymous. Attention channels (`meshVisibility`, `hoverDwell`,
  `gaze`, `resourceSample`) are **off by default** — keep them opt-in.
- Picking is **physics-free** (`pc.Ray` against mesh-instance world AABBs) so the connector adds
  no `ammo` dependency — do not route picks through the rigidbody system.
- `registerRegions(sceneId, regions, { endpoint, apiKey })` (from `@uptimizr/sdk-core`) declares a
  scene's named regions. It **replaces** the scene's set and needs an **`annotate`**-capable key —
  never ship that key in a public bundle; call it from build/deploy/admin code.
- Not captured on PlayCanvas, by design: `compile_stall` (no public compile hook) and
  `capability_change` (report it yourself via `client.reportCapabilityChange(...)`).
- To support another engine, create a sibling package depending only on `@uptimizr/sdk-core` and
  `@uptimizr/schema`; see the repo `add-connector` skill.

## More

- Package reference: [README.md](./README.md)
- Connector guide: https://uptimizr.com/docs/connectors/playcanvas/
- Integration guide: https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md

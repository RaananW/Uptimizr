# AGENTS.md — @uptimizr/babylon-lite

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

The **Babylon Lite** (`@babylonjs/lite`) connector for Uptimizr (ADR 0024). It registers as an
`@uptimizr/sdk-core` **collector** and captures camera pose, pointer move/click/button
transitions, camera gestures, mesh picks, frame performance, and opt-in mesh visibility, hover
dwell, gaze and resource/actor channels.

Babylon Lite is a functional / data-oriented, **WebGPU-only** Babylon engine — no classes, no
scene observables — so this connector mirrors the **three.js** adapter's shape (the app owns the
canvas and the render loop, and picking is explicit), not the class-based `@uptimizr/babylon`
adapter.

`@babylonjs/lite` is an **optional peer dependency**; the connector reads the host page's Lite
instance and never bundles its own. Lite's native frame is **left-handed, y-up, unit-scale 1** —
identical to the canonical wire frame (ADR 0018) — so the `toCanonical*` normalizers are
identities, still applied at the emission boundary for provenance and symmetry.

## Install

```bash
pnpm add @uptimizr/babylon-lite
# `@babylonjs/lite` is an optional peer dependency provided by your app.
```

## Canonical usage

The app owns the canvas and drives the render loop, so `scene`, `camera` and `canvas` are all
explicit arguments:

```ts
import { trackScene } from "@uptimizr/babylon-lite";

const client = trackScene(scene, camera, canvas, {
  projectId: "your-project",
  endpoint: "https://collect.example.com",
});
// ... later, on teardown
await client.stop("manual");
```

Use `trackSceneAsync(scene, camera, canvas, options)` (or pass
`graphics: await readGraphicsAsync()`) when you want the real WebGPU backend resolved before
`session_start`.

`trackScene` returns the `@uptimizr/sdk-core` `UptimizrClient`, so you can read
`client.sessionId`, emit custom events with `client.track(name, props)`, switch scene with
`client.setScene(sceneId)`, and `client.stop(reason)` to tear everything down. `stop()` clears
every timer, detaches all DOM listeners, sets a `disposed` flag (so the `onBeforeRender` callback
no-ops and late `pickAsync` resolutions are dropped) and disposes the GPU picker **the connector
created**. A picker you passed in via the `picker` option stays yours to `dispose()`.

### Advanced (compose it yourself)

```ts
import { UptimizrClient } from "@uptimizr/sdk-core";
import { liteCollector, readDeviceCaps } from "@uptimizr/babylon-lite";

const client = new UptimizrClient({
  projectId: "your-project",
  endpoint: "https://collect.example.com",
});
client.use(liteCollector({ scene, camera, canvas }));
client.start({ device: readDeviceCaps() });
```

## Capture knobs

`sampleCameraMs`, `samplePerfMs`, `pointerMoveThrottleMs`, `suppressIdleSamples`,
`suppressIdlePerfSamples`, `cameraEpsilon`, `perfFpsThreshold`, and a `capture` toggle map
(`LiteCaptureOptions`). The `sampling` profile sets per-channel fidelity in Hz (`0` = off,
`"frame"` = every tick) for continuous channels only — camera, pointer move, perf (ADR 0012).
Discrete events (clicks, picks, custom) are always captured.

Other `TrackSceneOptions`: `gaze`, `actors` (+ `sampling.nodes`, ADR 0027), `picker` (supply your
own `LitePickProbe`), `pickPixelRatio` (pass `window.devicePixelRatio` when the swapchain backing
store is DPR-scaled), `sceneDescription`, `user`, `meta`, `connector`, `graphics`,
`flushIntervalMs`, `transport`, `disabled`, `debug`.

## Rules for agents

- Treat `@babylonjs/lite` as an **optional** peer dependency; never bundle it.
- Emit only `@uptimizr/schema` events; do not redefine event shapes.
- Pointer/mesh events carry an input `source` (`mouse`/`touch`/`pen`, ADR 0011) — do not strip it.
- Privacy (ADR 0003): no cookies, no persistent client identifier. `user.id` must be pseudonymous.
  Attention channels (`meshVisibility`, `hoverDwell`, `gaze`, `resourceSample`) are **off by
  default** — keep them opt-in.
- **Picking is asynchronous** (GPU readback). Button transitions (`pointer_down` / `pointer_up`)
  deliberately emit screen + button only, to bound GPU readbacks — do not add a pick there.
- Lite is WebGPU-only: `graphics.api` is always `webgpu` and `shadingLanguage` is `wgsl`. Channels
  Lite does not expose (synchronous device caps, WebGL context-loss DOM events) are **omitted, not
  fabricated**.
- `registerRegions(sceneId, regions, { endpoint, apiKey })` (from `@uptimizr/sdk-core`) declares a
  scene's named regions. It **replaces** the scene's set and needs an **`annotate`**-capable key —
  never ship that key in a public bundle; call it from build/deploy/admin code.
- To support another engine, create a sibling package depending only on `@uptimizr/sdk-core` and
  `@uptimizr/schema`; see the repo `add-connector` skill.

## More

- Package reference: [README.md](./README.md)
- Connector guide: https://uptimizr.com/docs/connectors/babylon-lite/
- Integration guide: https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md

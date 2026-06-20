# @uptimizr/babylon-lite

The **Babylon Lite** (`@babylonjs/lite`) connector for [Uptimizr](../../../README.md) — captures
camera pose, pointer/click heatmap input, mesh picks, and frame performance from a Babylon Lite
scene and ships them to an Uptimizr collector.

Babylon Lite is a brand-new **functional / data-oriented, WebGPU** Babylon engine — a different
paradigm from `@babylonjs/core` (no classes, no scene observables; free functions operate on
context structs). This connector therefore mirrors the **three.js** adapter's shape (the app owns
the canvas + DOM input and picking is explicit), not the class-based `@uptimizr/babylon` adapter.

`@babylonjs/lite` is an **optional peer dependency** — the connector reads from the host page's
Lite instance and never bundles its own.

> Note on licensing: `@babylonjs/lite`'s npm metadata omits/mislabels its license; the package is
> in fact **Apache-2.0** (same as the rest of Babylon.js).

## Install

```bash
npm install @uptimizr/babylon-lite @babylonjs/lite
```

`@babylonjs/lite` is an **optional peer dependency** — the connector reads your
existing Babylon Lite instance and never bundles its own.

## Quick start

```ts
import {
  createEngine,
  createSceneContext,
  createArcRotateCamera,
  attachControl,
} from "@babylonjs/lite";
import { trackScene } from "@uptimizr/babylon-lite";

const engine = await createEngine(canvas);
const scene = createSceneContext(engine);
const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.5, 16, { x: 0, y: 1, z: 0 });
attachControl(camera, canvas, scene);

// The app owns the canvas and drives the render loop, so pass scene + camera + canvas explicitly.
const client = trackScene(scene, camera, canvas, {
  projectId: "your-project",
  endpoint: "https://collect.example.com",
});

// ... later
await client.stop("manual");
```

For finer control, register `liteCollector` with an sdk-core `UptimizrClient` via `client.use(...)`.

## What it captures

| Channel      | Schema event                        | Source                                                                                                         |
| ------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Camera pose  | `camera_sample`                     | `camera.worldMatrix` (position `[12,13,14]`, forward `[8,9,10]`), `camera.fov`; `target` for `ArcRotateCamera` |
| Frame perf   | `frame_perf`                        | FPS derived from the `deltaMs` Lite passes to `onBeforeRender`                                                 |
| Pointer move | `pointer_move`                      | DOM `pointermove` on the host canvas (throttled) + async GPU pick                                              |
| Clicks       | `pointer_click`                     | DOM `click` + async GPU pick                                                                                   |
| Buttons      | `pointer_down` / `pointer_up`       | DOM `pointerdown` / `pointerup` (screen + button)                                                              |
| Mesh picks   | `mesh_interaction` (`kind: "pick"`) | `createGpuPicker` + `pickAsync` on click                                                                       |

### Coordinate frame

Babylon Lite is **left-handed, y-up, unit-scale 1** — the same as Uptimizr's canonical wire frame —
so the `toCanonical*` normalizers are identities. They are still applied at the emission boundary
for provenance/symmetry; the emitted `connector.coordinateSystem` records the native frame.

### Graphics

Babylon Lite is **WebGPU-only**, so `graphics.api` is always `webgpu` and `shadingLanguage` is
`wgsl`. The real backend (Metal/D3D12/Vulkan) needs an async adapter round-trip and is left unset.

## Privacy & lifecycle

No cookies, no persistent client IDs. `dispose()` / `stop()` clears every timer, detaches
all DOM listeners, sets a `disposed` flag (so the `onBeforeRender` callback no-ops and late
`pickAsync` resolutions are dropped), and disposes the GPU picker the connector created.

## Notes / limitations

- **Async picking:** Lite picking is GPU-based and async, so pointer hit resolution is asynchronous.
  Button transitions (`pointer_down`/`pointer_up`) emit screen + button only (no pick) to bound the
  number of GPU readbacks.
- **Pixel ratio:** the GPU picker takes canvas pixel coordinates. CSS pixels are used by default;
  pass `pickPixelRatio: window.devicePixelRatio` when the swapchain backing store is DPR-scaled.
- Channels Lite doesn't expose (synchronous device caps, WebGL context-loss DOM events) are omitted
  rather than fabricated.

## License

[Apache-2.0](./LICENSE) © Uptimizr.

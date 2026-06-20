---
title: Performance & diagnostics
description: Frame-performance fields, GPU/memory footprint sampling, shader compile stalls, capability changes, and world-space gaze.
---

Beyond heatmaps, Uptimizr captures how the scene **performs** on real devices and where its rendering
cost and attention actually land.

## Frame performance (`frame_perf`)

The perf channel samples on a slow timer (default ≈0.5 Hz; tune via
[`sampling.perf`](/docs/guides/configuration/#capture-fidelity-sampling--preferred)). Beyond
`fps` / `frameTimeMs` / `drawCalls`, each sample reports percentiles and resolution over the window:

| Field                              | Meaning                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `frameTimeP95Ms`, `frameTimeP99Ms` | 95th/99th-percentile frame time over the window (jank tail).            |
| `longFrames`                       | Count of frames slower than `jankFrameMs` (default `50`) in the window. |
| `dpr`                              | Device pixel ratio.                                                     |
| `renderScale`                      | Engine hardware-scaling factor (`1` = native, `<1` = downscaled).       |

A steady FPS is meaningful telemetry, so the perf channel reports continuously by default. To dedupe a
stable frame rate, set `suppressIdlePerfSamples: true` (and tune `perfFpsThreshold`). Read the summary
from `GET /api/v1/perf`. `asset_load` events additionally carry an optional `ttiMs` alongside
`loadMs` / `ttffMs`.

## GPU / memory footprint (`resource_sample`) — opt-in

Off by default. When `capture.resourceSample` is enabled, the connector samples the _actual
cost the scene asks of the device_ on a slow timer (default every 15 s), separate from per-frame
`frame_perf`:

```ts
trackScene(scene, {
  // ...
  capture: { resourceSample: true },
  resourceSample: { intervalMs: 15000 }, // one footprint sample per window (default)
});
```

Each `resource_sample` carries whatever the engine can cheaply report, all optional: `textureBytes`,
`geometryBytes` (resident GPU memory), `triangles`, `vertices` (submitted last frame), and `jsHeapBytes`
(JS heap). Pair it with the device caps on `session_start` to spot scenes that overspend their target
hardware.

Coverage differs by engine (the SDK never mutates the engine): **Babylon** reports `triangles` (active
indices ÷ 3) and `vertices`; **three.js** reports `triangles` (`renderer.info.render.triangles`).
`jsHeapBytes` comes from `performance.memory` — **Chromium-only**, omitted elsewhere rather than zeroed.
Resident `textureBytes` / `geometryBytes` aren't on either engine's public surface, so they're left
unset; the read API's averages ignore unreported metrics (an absent metric never reads as `0`).

## Shader compile stalls (`compile_stall`)

Babylon-only, on by default via `capture.compileStall`. Times Babylon's main-thread
shader/pipeline compilation span — the #1 source of first-interaction hitches — reporting `durationMs`
and `phase`. three.js has no equivalent engine hook.

## Capability changes

Fallbacks (WebGPU→WebGL2), quality/LOD auto-downgrades, and device recovery are **app-reported** via
`client.reportCapabilityChange(...)` — see
[custom events & input](/docs/guides/events/#capability-changes-fallbacks--recovery). They explain perf
and visual-fidelity variance across your user base; read the rollup from `GET /api/v1/capabilities`.

## World-space gaze (`gaze`) — opt-in

Off by default (privacy + cost). When `capture.gaze` is enabled, the connector raycasts the
**camera-forward ray into the scene** on each frame that already emits a `camera_sample`, and attaches
the surface hit to that sample as `hitPoint` (world-space point) + `hitMesh` (hit object's name). This
answers "where did the audience's _gaze_ rest on the actual geometry" for every camera style (orbit,
first-person, XR) — distinct from the click-only world heatmap and the abstract view-direction sphere.

```ts
trackScene(scene, {
  // ...
  capture: { gaze: true },
  gaze: {
    maxDistance: 1000, // ignore hits farther than this along the ray (default)
    meshes: ["product-hero"], // allowlist; omit to hit any mesh
    predicate: (mesh) => mesh.name !== "ground", // exclude skybox/helpers (sync connectors)
  },
});
```

Gaze is **cheap by design**: one pick per _emitted_ pose. It rides the existing, idle-suppressed camera
cadence — it never adds a timer or picks at frame rate, and a static (pose-deduped) frame costs nothing.
The hit is normalized to the canonical coordinate frame at the emission boundary, so the
`gaze` heatmap aligns with the pointer world heatmap across engines.

Connector parity (same `capture.gaze` flag + `GazeOptions`):

- **`@uptimizr/babylon`** — `scene.pickWithRay()` from `camera.getForwardRay()` (sync); `predicate` supported.
- **`@uptimizr/three`** — single reused `THREE.Raycaster` from NDC centre (sync); `predicate` over `Object3D`.
- **`@uptimizr/playcanvas`** — single reused `pc.Ray` vs mesh-instance AABBs (sync, physics-free); `predicate` over `GraphNode`.
- **`@uptimizr/babylon-lite`** — async GPU picker at the centre pixel; the hit rides the **next** sample (≤ 1 sample latency); **no `predicate`** (name allowlist + `maxDistance` only).
- **`@uptimizr/r3f`** — inherits three's options; pass `capture.gaze` + `gaze` through `useUptimizr` / `<Uptimizr>`.
- **`@uptimizr/aframe`** — flat HTML schema exposes a boolean toggle only: `<a-scene uptimizr="gaze: true">`.

:::note
Head-forward gaze is a **proxy**, not eye-tracked gaze: a centered model can over-attribute gaze to
whatever sits at screen center.
:::

Read the result via `GET /api/v1/heatmaps/gaze` — it reuses the world heatmap's voxel grid, params, and
3D renderer. You can also paint it [into your own scene](/docs/guides/overlays/).

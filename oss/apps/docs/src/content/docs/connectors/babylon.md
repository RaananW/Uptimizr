---
title: Babylon.js
description: Instrument a Babylon.js scene with the @uptimizr/babylon connector.
---

The Babylon.js connector. `@babylonjs/core` is a peer dependency — the connector reads your
existing scene and never bundles or mutates it.

## Install

```bash
npm install @uptimizr/babylon @babylonjs/core
```

## Usage

The quickest integration is a single call:

```ts
import { trackScene } from "@uptimizr/babylon";

const tracker = trackScene(scene, {
  projectId: "your-project",
  endpoint: "https://collect.example.com",
});

// later, on teardown
tracker.dispose();
```

`trackScene` creates the client, registers the Babylon collector, reads device/GPU caps, and starts
the session. The return value exposes the session id, custom events, and lifecycle:

```ts
tracker.track("add_to_cart", { sku: "ABC-123" });
tracker.setScene("level-2");
tracker.dispose();
```

## Choosing the camera

By default the connector records the engine's active camera. For multi-camera scenes
(picture-in-picture, split-screen, render-target rigs) set `camera` explicitly — otherwise the
"active" camera is ambiguous and the view-direction heatmap can collapse to a single direction:

```ts
trackScene(scene, { projectId, endpoint, camera: mainCamera });
```

## First-person scenes (pointer lock)

When the rendering canvas holds the browser [Pointer Lock](https://developer.mozilla.org/docs/Web/API/Pointer_Lock_API)
(`engine.enterPointerlock()`, first-person/FPS navigation), the OS cursor is hidden and the aim point
is the fixed crosshair at the viewport centre. The connector detects pointer lock and reports
`pointer_move` / `pointer_down` / `pointer_up` / `pointer_click` from screen centre
(`screen = [0.5, 0.5]`), re-picking at the render-target centre — the crosshair the visitor actually
aims with. The 2D pointer heatmap therefore clusters at the centre for locked scenes; read the
cursor-independent gaze / floor-plan heatmaps instead. Cursor (orbit/viewer) scenes are unaffected.
See [Concepts → pointer lock](/docs/concepts/) (ADR 0034).

## Capture fidelity

Continuous channels are sampled at conservative defaults (≈1 Hz camera, ≈4 Hz pointer, ≈0.5 Hz
perf). Raise or lower them per channel with `sampling` (rates in Hz, `"frame"` for every tick, or
`0` to disable):

```ts
trackScene(scene, {
  projectId,
  endpoint,
  sampling: {
    camera: 10, // 10 Hz camera pose
    pointerMove: 60, // 60 Hz pointer movement
    perf: 0.5, // a perf sample every 2 s
  },
});
```

Discrete events (clicks, mesh interactions, scene changes, custom events) are always captured at
100% and cannot be rate-limited.

## Opt-in channels

Off by default for privacy and cost — enable as needed:

```ts
trackScene(scene, {
  projectId,
  endpoint,
  capture: { hoverDwell: true, resourceSample: true, gaze: true },
  meshVisibility: { meshes: ["product-hero"], windowMs: 5000 },
});
```

- `meshVisibility` — per-object dwell summaries (`mesh_visibility`).
- `capture.hoverDwell` — hover hesitation episodes (`hover_dwell`).
- `capture.resourceSample` — GPU/memory footprint (`resource_sample`).
- `capture.gaze` — world-space gaze hit points (`camera_sample.hitPoint`).
- `captureErrors` — opt-in `runtime_error` capture (not auto-redacted).

## Scene proxy (3D heatmap backdrop)

To draw 3D heatmaps against a recognizable backdrop without shipping your real geometry, register a
lightweight proxy (per-mesh bounding boxes):

```ts
import { scanSceneProxy } from "@uptimizr/babylon";

const proxy = scanSceneProxy(scene, { sceneId: "lobby" });
// PUT it to /api/v1/scenes/lobby/representation (see the HTTP API docs)
```

For a custom transport or a `beforeSend` hook, see [sdk-core (advanced)](/docs/connectors/sdk-core/).

---
title: three.js
description: Instrument a three.js scene with the @uptimizr/three connector.
---

The three.js connector. `three` is a peer dependency — the connector reads your existing three.js
instance and never bundles or mutates it.

## Install

```bash
npm install @uptimizr/three three
```

## Usage

Because three.js has no `scene.activeCamera` and the connector reads FPS and the canvas from the
renderer, `camera` and `renderer` are explicit arguments:

```ts
import { trackScene } from "@uptimizr/three";

const client = trackScene(scene, camera, renderer, {
  projectId: "your-project",
  endpoint: "https://collect.example.com",
});

// later, on teardown
await client.stop("manual");
```

`trackScene` creates the client, registers the collector, reads device/GPU caps, and starts the
session. It returns the `@uptimizr/sdk-core` `UptimizrClient`, so you can read `client.sessionId`,
emit custom events, or stop it.

## Coordinate frame

World-space data is normalized from three's native **right-handed, y-up** frame to the canonical
wire frame (**left-handed, y-up**) at the emission boundary. The session is attributed to the
`three` connector and records three's native frame in `connector.coordinateSystem`.

## Capture

Captures camera pose → view-direction heatmap, pointer move/click (with optional raycast hit) →
screen heatmaps, mesh picks → object engagement, and FPS → performance. Opt-in: mesh visibility,
hover dwell, and resource sample.

## First-person scenes (pointer lock)

When the canvas holds the browser [Pointer Lock](https://developer.mozilla.org/docs/Web/API/Pointer_Lock_API)
(e.g. `PointerLockControls`, first-person/FPS navigation), the OS cursor is hidden and the aim point
is the fixed crosshair at the viewport centre. The connector detects pointer lock and reports
pointer/click events from screen centre (`screen = [0.5, 0.5]`), raycasting from the centre — so the
2D pointer heatmap clusters at the centre for locked scenes. Read the cursor-independent gaze /
floor-plan heatmaps instead; cursor (orbit/viewer) scenes are unaffected.
See [Concepts → pointer lock](/docs/concepts/) (ADR 0034).

## WebXR

`trackScene` registers the WebXR collector **by default**. It costs two event listeners while idle
and attaches when `renderer.xr` enters an immersive session, mapping XR input onto the existing
source-neutral events (ADR 0011): controller/gaze **pose** → `pointer_move` with a world-space `ray`
and `source` (`xr-controller`, `hand`, `gaze`, `transient`), **select** → `pointer_click` (+
`mesh_interaction` `kind: select`), **squeeze** → `mesh_interaction` `kind: squeeze`. The headset
pose keeps flowing as `camera_sample`.

To resolve those rays to **in-scene hits** (`hitPoint`/`hitMesh` on the ray samples, and the object
a select/squeeze attaches to), pass a raycast probe. `createXrRaycaster` builds one over the live
scene graph with a single reused `THREE.Raycaster`:

```ts
import { trackScene, createXrRaycaster } from "@uptimizr/three";

const client = trackScene(scene, camera, renderer, {
  projectId: "your-project",
  endpoint: "https://collect.example.com",
  xr: {
    sampleMs: 250, // controller/gaze pose cadence
    raycast: createXrRaycaster(scene, { maxDistance: 50 }), // optional: hit resolution
  },
});
```

Without a probe, rays and clicks are still captured; only the hit fields need one. Pass `xr: false`
to disable XR capture entirely. Name the objects you care about (`object3D.name`) so `hitMesh` is
meaningful. Set `cameraType` if the structural guess is wrong: every `PerspectiveCamera` classifies
as `free` (first-person), so pass `cameraType: "arc-rotate"` for orbit-style scenes.

## Advanced

For a custom transport, a `beforeSend` hook, or registering multiple collectors, compose the pieces
directly:

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

See [sdk-core (advanced)](/docs/connectors/sdk-core/) for the full client API.

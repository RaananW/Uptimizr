---
title: Babylon Lite
description: Instrument a Babylon Lite (@babylonjs/lite) scene with the @uptimizr/babylon-lite connector.
---

The **Babylon Lite** connector. Babylon Lite is a functional / data-oriented, WebGPU-only Babylon
engine — no classes, no scene observables. Because the app owns the canvas and drives the render
loop, this connector mirrors the three.js adapter's shape: pass the scene, camera, and canvas
explicitly.

`@babylonjs/lite` is an optional peer dependency — the connector reads your existing instance and
never bundles its own.

## Install

```bash
npm install @uptimizr/babylon-lite @babylonjs/lite
```

## Usage

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

// The app owns the canvas and render loop, so pass scene + camera + canvas explicitly.
const client = trackScene(scene, camera, canvas, {
  projectId: "your-project",
  endpoint: "https://collect.example.com",
});

// later, on teardown
await client.stop("manual");
```

`trackScene` returns the `@uptimizr/sdk-core` `UptimizrClient`. Read `client.sessionId`, emit custom
events with `client.track(...)`, or stop the session early.

## Coordinate frame & graphics

Babylon Lite is **left-handed, y-up, unit-scale 1** — the same as Uptimizr's canonical wire frame —
so the coordinate normalizers are identities (still applied for provenance). It is **WebGPU-only**,
so `graphics.api` is always `webgpu` and the shading language is `wgsl`.

## Capture

The Lite connector captures camera pose (`camera_sample`), pointer move/click and buttons,
mesh picks via GPU picking (`mesh_interaction`), and frame perf. It has no named-bone API, so
scene-actor capture is Tier 1 (node/root transforms) only.

For finer control, register `liteCollector` with an sdk-core `UptimizrClient` via `client.use(...)`
— see [sdk-core (advanced)](/docs/connectors/sdk-core/).

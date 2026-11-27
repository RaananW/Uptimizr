---
title: Heatmaps for three.js scenes
description: Click, view-direction, gaze and floor-plan heatmaps for three.js and React Three Fiber, what each one answers, and how to draw one inside your own scene.
lastUpdated: 2026-11-27
---

A page heatmap shows where people clicked on a flat page. A three.js scene needs more than one kind,
because "where" can mean a spot on the screen, a point on a model, a direction the camera faced, or
a place the visitor stood. This page covers the heatmaps that
[`@uptimizr/three`](/docs/connectors/three/) and [`@uptimizr/r3f`](/docs/connectors/r3f/) produce,
which question each one answers, and how to draw one inside your own scene.

## Which heatmap answers which question

| Heatmap               | Question it answers                        | Data source                      | Endpoint                          |
| --------------------- | ------------------------------------------ | -------------------------------- | --------------------------------- |
| Pointer (screen)      | Where on screen do people point and click? | Pointer moves and clicks         | `GET /api/v1/heatmaps/pointer`    |
| World (3D clicks)     | Where in the scene do people click?        | Raycast hit points               | `GET /api/v1/heatmaps/world`      |
| View direction        | Which way do people look?                  | Camera forward vectors           | `GET /api/v1/heatmaps/camera`     |
| Gaze                  | What does their gaze actually rest on?     | Camera-forward ray hits (opt-in) | `GET /api/v1/heatmaps/gaze`       |
| Floor plan (position) | Where do people stand and linger?          | Camera positions                 | `GET /api/v1/heatmaps/position`   |
| Click rays            | From where did people click what?          | Click origin and hit             | `GET /api/v1/heatmaps/click-rays` |
| Performance           | Where in the scene does FPS drop?          | FPS samples by camera position   | `GET /api/v1/heatmaps/perf`       |

All of them come from the default capture except gaze, which you turn on with `capture.gaze`. Every
endpoint accepts `since`, `until` and `scene` filters, and the dashboard renders each one.

## Screen and world click heatmaps

The **pointer heatmap** bins pointer positions over the normalized viewport. It's the closest thing
to a classic web heatmap, and it works well for fixed-camera views and UI overlaid on the canvas.

The **world heatmap** bins the 3D point each click hit into cubes (voxels) of `cellSize` world
units. It stays correct when the camera moves, which the screen heatmap can't: a click on the
product's handle lands in the same voxel whether the visitor was looking from the front or the side.

```http
GET /api/v1/heatmaps/world?cellSize=0.25&scene=showroom
x-api-key: your-project-api-key
```

Pick a `cellSize` that fits your scene's units. A product a metre wide might use `0.05`, and a
walkable building might use `0.5`.

## View direction and gaze

The **view-direction heatmap** bins the camera's forward direction on a sphere. It needs no
geometry, so it works for every scene, including an empty skybox. In the dashboard it's a top-down
polar plot: the centre is looking straight up, the middle ring is the horizon and the rim is looking
straight down.

The **gaze heatmap** goes one step further. It casts the camera-forward ray into the scene and bins
where it landed on real geometry, so it shows what people looked at rather than which way they
faced. Turn it on in the connector:

```ts
trackScene(scene, camera, renderer, {
  projectId: "my-three-app",
  endpoint: "https://collect.example.com",
  capture: { gaze: true },
  gaze: { predicate: (object) => object.name !== "ground" }, // skip the floor and helpers
});
```

Gaze adds one raycast per camera sample that's actually sent, not one per frame, and nothing while
the camera is still. It's based on where the camera points, not on eye tracking, so a model at the
centre of the screen can collect more gaze than it deserves.

## Floor-plan heatmaps for walkable scenes

In a first-person or walkable scene, the **position heatmap** bins camera positions onto the ground
plane, with the mean height per cell. It shows where visitors stand and linger, and which areas they
never reach. `GET /api/v1/paths` returns each session's route on the same grid.

These scenes usually use `PointerLockControls`. While pointer lock is held, the connector reports
clicks from the crosshair at the centre of the screen, so the screen pointer heatmap clusters in the
middle. Use the gaze, floor-plan and world heatmaps for these scenes instead.

## Draw a heatmap inside your own three.js scene

The dashboard draws world and gaze heatmaps in 3D. If you register a proxy of your scene's
bounding boxes with `scanSceneProxy` from `@uptimizr/three`, it draws them against that backdrop.
To see them on your real models, fetch the voxels and draw them yourself. `@uptimizr/heatmap` has an
engine-free core that turns voxels into positioned, coloured cubes. Its ready-made drivers are for
Babylon.js, so for three.js you provide a small driver built on `InstancedMesh`:

```ts
import * as THREE from "three";
import { fetchWorldHeatmap, HeatmapOverlay } from "@uptimizr/heatmap";
import type { HeatmapDriver } from "@uptimizr/heatmap";

function createThreeHeatmapDriver(scene: THREE.Scene, maxVoxels = 2000): HeatmapDriver {
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false }),
    maxVoxels,
  );
  // The `uptimizr-` prefix keeps the overlay out of click and gaze raycasts.
  mesh.name = "uptimizr-heatmap";
  mesh.count = 0;
  scene.add(mesh);

  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();

  return {
    render(instances) {
      const n = Math.min(instances.length, maxVoxels);
      for (let i = 0; i < n; i++) {
        const { position, scale, color: rgba } = instances[i]!;
        // Heatmap positions use a left-handed frame and three.js is right-handed, so flip z.
        matrix.makeScale(scale, scale, scale).setPosition(position[0], position[1], -position[2]);
        mesh.setMatrixAt(i, matrix);
        mesh.setColorAt(i, color.setRGB(rgba[0], rgba[1], rgba[2]));
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
    clear() {
      mesh.count = 0;
    },
    setVisible(visible) {
      mesh.visible = visible;
    },
    dispose() {
      scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    },
  };
}

const overlay = new HeatmapOverlay(createThreeHeatmapDriver(scene), { maxVoxels: 2000 });
overlay.render(await fetchWorldHeatmap({ endpoint, apiKey, sceneId: "showroom", cellSize: 0.25 }));
```

The gaze heatmap returns the same voxel rows, so the same overlay can draw it:

```ts
const res = await fetch(`${endpoint}/api/v1/heatmaps/gaze?cellSize=0.25&scene=showroom`, {
  headers: { "x-api-key": apiKey },
});
overlay.render({ voxels: await res.json(), cellSize: 0.25 });
```

Use the same `cellSize` for the query and the overlay. An overlay needs a read API key, so build it
into an internal or development view, not the page your visitors load. See
[In-scene heatmap overlays](/docs/guides/overlays/) for the core's style options and the gaze dome
builders.

## What three.js doesn't capture yet

The per-mesh UV heatmap (`GET /api/v1/heatmaps/mesh-uv`), which shows which part of a single
model's texture gets clicked, needs the hit's texture coordinate. Today only the Babylon.js
connector reports it, so this heatmap stays empty for three.js and R3F scenes.

## Next steps

- Read [The complete guide to analytics for three.js apps](/docs/learn/threejs-analytics/) for
  setup and the other signals.
- Read [Concepts → heatmaps](/docs/concepts/#heatmaps) for how each type is binned.
- Open the [live demo](https://demo.uptimizr.com) to see every heatmap on a sample scene.

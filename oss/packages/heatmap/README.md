# @uptimizr/heatmap

Draw a world-space **heatmap overlay** into the developer's **own** 3D scene —
the Tier 0 "dev-integrated overlay" approach.
It re-uses the same `GET /api/v1/heatmaps/world` voxel data the dashboard renders,
but paints the heat directly onto the live scene you already ship.

The core is **framework-agnostic** (it turns voxel counts into normalized,
positioned, colored instances); engine adapters live behind subpaths. The Babylon
adapter renders the voxels as a single thin-instanced box, so thousands of cells
stay one draw call.

## Install

```bash
npm install @uptimizr/heatmap @babylonjs/core
```

The engine (`@babylonjs/core` or `@babylonjs/lite`) is an **optional peer
dependency** — install the one your scene already uses. The overlay reads the
collector's `GET /api/v1/heatmaps/world` voxel data and draws into your own scene.

## Usage

```ts
import { showWorldHeatmap } from "@uptimizr/heatmap/babylon";

// One call: fetch + render into your existing Babylon scene.
const overlay = await showWorldHeatmap({
  scene, // your host scene
  endpoint: "https://collect.example.com",
  apiKey: "utk_…",
  sceneId: "lobby", // optional sceneId filter
  cellSize: 0.5, // must match how you want the grid binned
  style: { opacity: 0.85, maxVoxels: 2000 },
});

overlay.setVisible(false); // toggle
overlay.dispose(); // remove from the scene
```

Lower-level, if you manage fetching yourself or want to re-render on a control:

```ts
import { HeatmapOverlay } from "@uptimizr/heatmap";
import { createBabylonHeatmapDriver } from "@uptimizr/heatmap/babylon";

const overlay = new HeatmapOverlay(createBabylonHeatmapDriver({ scene }), {
  opacity: 0.85,
});
overlay.render({ voxels, cellSize: 0.5 }); // call again whenever data changes
```

## Gaze (view-direction) dome

Alongside the world voxel heatmap, the package can draw a **gaze dome** — the
camera view-direction distribution (`GET /api/v1/heatmaps/camera`) reconstructed
as markers on a sphere. Center it on the live camera and the developer literally
stands inside the distribution of where visitors looked. This is the in-scene
(Tier 0) counterpart of the dashboard's `CameraDome3D` viewer.

```ts
import { showGazeDome } from "@uptimizr/heatmap/babylon";

const gaze = await showGazeDome({
  scene,
  endpoint: "https://collect.example.com",
  apiKey: "utk_…",
  sceneId: "lobby", // optional scene filter
  sessionId, // optional: one session instead of the aggregate
  bins: 36, // grid resolution per axis (must match the dashboard)
  followCamera: scene.activeCamera ?? undefined, // dome tracks the viewer
  style: { radius: 8, opacity: 0.9 }, // radius is in the host scene's units
});

gaze.setVisible(false); // toggle
gaze.dispose(); // remove from the scene (also detaches the camera follower)
```

Like the world heatmap, the core is engine-free: `buildGazeInstances(data, style)`
turns `{ azimuthBin, elevationBin, count }` bins into dome `HeatmapInstance`s, so a
non-Babylon host can render gaze with any `HeatmapDriver`.

## Gaze skydome

For a continuous view-direction field instead of discrete markers, the Babylon
adapter can draw the same camera heatmap as an inward-facing equirectangular
skydome:

```ts
import { showGazeSkydome } from "@uptimizr/heatmap/babylon";

const sky = await showGazeSkydome({
  scene,
  endpoint: "https://collect.example.com",
  apiKey: "utk_…",
  sceneId: "lobby",
  followCamera: scene.activeCamera ?? undefined,
  texture: { width: 512, blurBins: 1.5, opacity: 0.9 },
});

sky.setVisible(false);
sky.dispose();
```

The engine-free `buildGazeEquirect(data, options?)` helper returns raw RGBA
pixels for hosts that want to upload the texture themselves.

## Design

- **`buildHeatmapInstances(data, style)`** is pure and engine-free: it normalizes
  counts against the busiest voxel, places each at its world center
  `((v + 0.5) * cellSize)`, sizes it by intensity, and colors it via the ramp.
- **`buildGazeInstances(data, style)`** mirrors it for gaze: it inverts the
  server's spherical binning back to a unit direction and drops a marker at
  `center + direction * radius`, normalized against the busiest bin.
- **`HeatmapDriver`** is the engine extension point — implement
  `{ render, clear, setVisible, dispose }` for another engine and pass it to
  `HeatmapOverlay` (or `GazeOverlay`).
- The default cold→hot ramp runs blue → cyan → green → yellow → red → white-hot.
- There is **no scene registry at this tier**: `cellSize` and the
  gaze `radius` have no inherent units, so the host supplies them (or exposes them
  as controls).

`@babylonjs/core` and `@babylonjs/lite` are **optional peer dependencies** — only
needed for the Babylon adapter you import.

## Develop

```bash
pnpm --filter @uptimizr/heatmap build
pnpm --filter @uptimizr/heatmap typecheck
pnpm --filter @uptimizr/heatmap test
```

## License

[Apache-2.0](./LICENSE) © Uptimizr.

---
title: In-scene heatmap overlays
description: Paint world heatmaps and gaze domes into your own running scene with @uptimizr/heatmap.
---

Beyond the dashboard viewers, you can paint analytics **into your own running scene** (a
dev-integrated overlay) with `@uptimizr/heatmap`. The core is engine-agnostic; the Babylon
adapter draws everything as a single thin-instanced mesh.

```bash
npm install @uptimizr/heatmap
```

```ts
import { showWorldHeatmap, showGazeDome, showGazeSkydome } from "@uptimizr/heatmap/babylon";

// World-space pointer heatmap (GET /api/v1/heatmaps/world) as voxel blocks.
const world = await showWorldHeatmap({
  scene,
  endpoint: "https://collect.example.com",
  apiKey: "your-project-api-key",
  cellSize: 0.5, // must match how the grid is binned
  style: { opacity: 0.85, maxVoxels: 2000 },
});

// Gaze dome (GET /api/v1/heatmaps/camera): view-direction distribution as
// markers on a sphere, optionally centered on the live camera.
const gaze = await showGazeDome({
  scene,
  endpoint: "https://collect.example.com",
  apiKey: "your-project-api-key",
  bins: 36, // grid resolution per axis
  followCamera: scene.activeCamera ?? undefined,
  style: { radius: 8, opacity: 0.9 }, // radius is in the host scene's units
});

// Gaze skydome (same camera query, continuous form): splats the bins into an
// equirectangular heat texture on an inward-facing dome centered on the camera,
// so you can stand inside the field — especially natural in WebXR.
const sky = await showGazeSkydome({
  scene,
  endpoint: "https://collect.example.com",
  apiKey: "your-project-api-key",
  bins: 36,
  followCamera: scene.activeCamera ?? undefined,
  radius: 50, // larger than your scene; you view it from inside
  texture: { width: 256, blurBins: 1.5, opacity: 0.95 },
});

world.setVisible(false); // toggle any overlay
gaze.dispose();          // remove from the scene when done
sky.dispose();
```

Both helpers return an overlay handle (`render` / `setVisible` / `dispose`). There is no scene registry
at this tier, so `cellSize` and the gaze `radius` have **no inherent units** — supply values that fit
your scene (or expose them as controls).

The gaze data has two in-scene forms: `showGazeDome` drops discrete markers on a sphere, while
`showGazeSkydome` paints the **continuous** equirectangular heat field of the same bins (its
engine-free builder, `buildGazeEquirect`, is exported for non-Babylon hosts). The dashboard's
view-direction dome panel offers the same **Markers / Skydome** toggle.

For a no-bundler page, the package also ships an ESM build you can load from a
`<script type="module">` (or a CDN like jsDelivr/unpkg) instead of installing from npm.

## See also

- [Performance & diagnostics → gaze](/docs/guides/performance/#world-space-gaze) — capture the data this
  dome visualizes.
- [Session replay](/docs/guides/replay/) — re-drive a full session instead of an aggregate overlay.

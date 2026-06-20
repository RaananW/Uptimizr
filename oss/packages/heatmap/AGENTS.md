# AGENTS.md — @uptimizr/heatmap

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

Draws a world-space **heatmap overlay** into the developer's **own** 3D scene — the Tier 0
"dev-integrated overlay" of ADR 0010. It reuses the same `GET /api/v1/heatmaps/world` voxel data
the dashboard renders, but paints the heat directly onto the live scene you already ship. It can
also draw a **gaze dome** (camera view-direction distribution, `GET /api/v1/heatmaps/camera`).

The core is framework-agnostic (it turns voxel/bin counts into normalized, positioned, colored
instances); engine adapters live behind subpaths. The Babylon adapter renders voxels as a single
thin-instanced box, so thousands of cells stay one draw call.

## Install

```bash
pnpm add @uptimizr/heatmap
# @babylonjs/core is an optional peer dependency — only for the Babylon adapter.
```

## Canonical usage

```ts
import { showWorldHeatmap } from "@uptimizr/heatmap/babylon";

const overlay = await showWorldHeatmap({
  scene,
  endpoint: "https://collect.example.com",
  apiKey: "utk_…",
  sceneId: "lobby",
  cellSize: 0.5,
  style: { opacity: 0.85, maxVoxels: 2000 },
});
overlay.setVisible(false);
overlay.dispose();
```

Gaze dome: `showGazeDome({ scene, endpoint, apiKey, bins, followCamera, style })`.

## Rules for agents

- The pure builders `buildHeatmapInstances(data, style)` and `buildGazeInstances(data, style)` are
  engine-free — keep them free of engine imports so non-Babylon hosts can render.
- `HeatmapDriver` `{ render, clear, setVisible, dispose }` is the engine extension point.
- There is **no scene registry at this tier** (ADR 0010 §4a): the host supplies `cellSize` and the
  gaze `radius` (they have no inherent units). Do not assume a unit scale.
- Treat `@babylonjs/core` as an optional peer dependency.

## More

- Package reference: [README.md](./README.md)
- Integration guide: https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md

---
title: Web exports (Unity, Godot, Unreal)
description: Instrument WebAssembly engine exports with the @uptimizr/web-export foundation and its two capture tiers.
---

Unity, Godot, and Unreal compile to **WebAssembly** and render into a `<canvas>`, so
there is no live JavaScript scene to read. The `@uptimizr/web-export` package is the
shared foundation behind the [`@uptimizr/unity`](/connectors/unity),
[`@uptimizr/godot`](/connectors/godot), and [`@uptimizr/unreal`](/connectors/unreal)
connectors. You normally install one of those engine packages — depend on
`@uptimizr/web-export` directly only to support a new web-export engine.

## Two capture tiers

| Tier | Engine code? | Captures |
| ---- | ------------ | -------- |
| **JS-only** | none | pointer move/click heatmaps, FPS / long frames, JS errors |
| **Bridged** | a thin copy-in shim | camera pose → view-direction heatmap, world-space picks, scene proxy, replay |

The **JS-only tier** is live the moment you start the connector — it captures purely
from the canvas DOM and `requestAnimationFrame`, with no engine changes at all. The
**bridged tier** activates when a small engine-side shim (a copy-in asset, not an npm
package) starts pushing world-space samples across the WASM↔JS boundary.

## Install

```bash
npm install @uptimizr/web-export
```

## Usage

```ts
import { trackWebExport } from "@uptimizr/web-export";

const { client, bridge } = trackWebExport({
  projectId: "your-project",
  endpoint: "https://collect.example.com",
  name: "my-engine",
  frame: { handedness: "right", upAxis: "z", unitScale: 100 }, // your engine's native frame
  canvas: () => document.querySelector("canvas"),
});

// The engine-side shim pushes world-space samples in the engine's native frame:
bridge?.pushPose([0, 1.6, 0], [0, 0, 1], [0, 1, 0], Math.PI / 3);
bridge?.pushPerf(60);

// later, on teardown
await client.stop("manual");
```

`bridge` is also exposed on `window` (default `window.__uptimizr_my-engine__`,
configurable via `bridgeGlobal`) so a WASM shim can find it by global name.

## The bridge contract

The engine-side shim calls a tiny, **versioned** API. All inputs are world-space in
the engine's native frame — the connector owns the single normalization path, so the
shim does no coordinate math.

```ts
interface EngineBridge {
  readonly protocolVersion: number; // === BRIDGE_PROTOCOL_VERSION
  pushPose(position: [x, y, z], forward: [x, y, z], up: [x, y, z], fov?: number): void;
  pushPick(objectName: string, hitPoint: [x, y, z]): void;
  pushPerf(fps: number, longFrames?: number): void;
  setSceneProxy(nodes: { name: string; aabb: [minX, minY, minZ, maxX, maxY, maxZ] }[]): void;
  dispose(): void;
}
```

## Coordinate frames

Each engine declares a **native frame** — `handedness`, `upAxis` (`"y"` or `"z"`), and
`unitScale` (world units per meter). The connector rebases z-up → y-up, applies the
unit scale, and flips handedness to reach the canonical wire frame (**left-handed,
y-up, unit scale 1**), then records the native frame in `connector.coordinateSystem`.

| Engine | Handedness | Up axis | Unit scale |
| ------ | ---------- | ------- | ---------- |
| Unity  | left  | y | 1 (meters, canonical) |
| Godot  | right | y | 1 (meters) |
| Unreal | left  | z | 100 (centimeters) |

## Privacy

No client-side persistent IDs and no PII by default (ADR 0003). The JS-only tier
records pointer positions and FPS; the bridge records poses and developer-assigned
**named** objects. Stopping the client tears down every listener, timer, and
animation-frame callback.

See [ADR 0045](https://github.com/RaananW/Uptimizr/blob/main/docs/adr/0045-web-export-engine-connectors.md)
for the full design.

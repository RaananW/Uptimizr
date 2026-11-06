---
title: Web exports (Unity, Godot, Unreal)
description: Instrument WebAssembly engine exports with the @uptimizr/web-export foundation and its two capture tiers.
lastUpdated: 2026-11-06
---

Unity, Godot, and Unreal compile to **WebAssembly** and render into a `<canvas>`, so
there is no live JavaScript scene to read. The `@uptimizr/web-export` package is the
shared foundation behind the [`@uptimizr/unity`](/docs/connectors/unity/),
[`@uptimizr/godot`](/docs/connectors/godot/), and [`@uptimizr/unreal`](/docs/connectors/unreal/)
connectors. Most of the time you install one of those engine packages, which bake in
the engine's native coordinate frame and connector name for you.

## When to use this directly

Reach for `@uptimizr/web-export` itself (rather than an engine package) when:

- **Your engine isn't one we ship a package for** — Wonderland, a Bevy/Rust `wasm`
  build, Stride, or any in-house Emscripten/WebAssembly renderer that draws to a
  `<canvas>`. You supply its native `frame` (`handedness` / `upAxis` / `unitScale`) and
  get both tiers for free.
- **The native frame is configurable or only known at runtime** — pass `frame`
  dynamically instead of relying on a hard-coded one.
- **You only want the JS-only tier on any canvas app** — pointer heatmaps, FPS, and JS
  errors with zero engine code, where engine-specific provenance doesn't matter. Use
  `trackWebExport`, or `startJsOnlyCapture` for the bare primitive.
- **You need custom bridge wiring** — `createEngineBridge` and the normalization
  helpers (`normalizePosition`, `normalizeDirection`, `normalizeAabb`, `rebaseZUpToYUp`)
  for a bespoke transport, a server-side normalization step, or tests.
- **You're authoring a new connector package** — a new `@uptimizr/<engine>` wraps this,
  exactly as `@uptimizr/unity` does.

If you're on Unity, Godot, or Unreal, prefer the engine package — it fixes the correct
native frame, sets the connector provenance name, and exposes the
`window.__uptimizr_<engine>__` global the matching copy-in shim expects.

## Two capture tiers

| Tier        | Engine code?        | Captures                                                                     |
| ----------- | ------------------- | ---------------------------------------------------------------------------- |
| **JS-only** | none                | pointer move/click heatmaps, FPS / long frames, JS errors                    |
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

## Options

`trackWebExport` takes the options below. `trackUnity`, `trackGodot` and `trackUnreal` take the same
set without `name` and `frame`.

| Option                  | Default               | Effect                                                                                  |
| ----------------------- | --------------------- | --------------------------------------------------------------------------------------- |
| `projectId`, `endpoint` | —                     | Required.                                                                               |
| `name`, `frame`         | —                     | Required on `trackWebExport`: connector id and native frame.                            |
| `canvas`                | —                     | The render canvas, or a resolver returning it once the export has booted.               |
| `capture`               | see below             | Toggle the JS-only channels.                                                            |
| `pointerMoveThrottleMs` | `250`                 | Minimum gap between `pointer_move` samples.                                             |
| `perfWindowMs`          | `2000`                | `frame_perf` reporting window.                                                          |
| `jankFrameMs`           | `50`                  | A frame slower than this counts as a long frame.                                        |
| `version`               | —                     | Engine version recorded as connector provenance.                                        |
| `sceneId`               | —                     | Scene id for a proxy pushed over the bridge. Use `meta.sceneId` to tag events.          |
| `bridgeGlobal`          | `__uptimizr_<name>__` | `window` property the shim finds the bridge on. `false` attaches none.                  |
| `onSceneProxy`          | —                     | Called with a wire-correct `SceneProxy` when the engine pushes one.                     |
| `user`, `meta`          | —                     | `session_start` context. Nothing fills in `graphics` here; pass it via `meta.graphics`. |
| `flushIntervalMs`       | `5000`                | Max time between flushes.                                                               |
| `transport`             | beacon → fetch        | Custom transport object.                                                                |
| `disabled`, `debug`     | `false`               | Collect nothing / console debug logs.                                                   |

| `capture` key | Default | Channel                                                  |
| ------------- | ------- | -------------------------------------------------------- |
| `pointerMove` | `true`  | `pointer_move`.                                          |
| `clicks`      | `true`  | `pointer_click`.                                         |
| `buttons`     | `false` | `pointer_down` / `pointer_up`.                           |
| `perf`        | `true`  | rAF `frame_perf`. Turn off if the shim calls `pushPerf`. |
| `errors`      | `true`  | `window` error + unhandled rejection → `runtime_error`.  |

The JS-only tier captures `runtime_error` **by default**, unlike the other connectors, where
capture is an opt-in `captureErrors` client option. These events are not auto-redacted and do not
get that option's de-duplication or 50-per-session cap, and `trackWebExport` has no `beforeSend`.
Disable them with `capture: { errors: false }`, or redact by building an `UptimizrClient` with a
`beforeSend` hook and registering `webExportCollector` (or `unityCollector` / `godotCollector` /
`unrealCollector`) on it.

`setSceneProxy` builds the proxy but does not upload it. Registering it is the host's job, from
`onSceneProxy`, with a [`PUT`](/docs/api/ingestion/#scene-registry-write) from a trusted context:
that write needs an API key, so it does not belong in a public bundle.

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

| Engine | Handedness | Up axis | Unit scale            |
| ------ | ---------- | ------- | --------------------- |
| Unity  | left       | y       | 1 (meters, canonical) |
| Godot  | right      | y       | 1 (meters)            |
| Unreal | left       | z       | 100 (centimeters)     |

## Privacy

No client-side persistent IDs and no PII by default (ADR 0003). The JS-only tier
records pointer positions, FPS and JS errors (see [Options](#options)); the bridge records
poses and developer-assigned **named** objects. Stopping the client tears down every
listener, timer, and animation-frame callback.

See [ADR 0045](https://github.com/RaananW/Uptimizr/blob/main/docs/adr/0045-web-export-engine-connectors.md)
for the full design.

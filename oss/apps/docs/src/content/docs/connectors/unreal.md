---
title: Unreal
description: Instrument an Unreal Engine web export with the @uptimizr/unreal connector.
---

The Unreal Engine (web export) connector. Unreal renders into a `<canvas>` via
WebAssembly, so it is built on the [web-export foundation](/connectors/web-export) and
works in two tiers: a **JS-only tier** (no engine code — pointer heatmaps, FPS, JS
errors) and a **bridged tier** (a thin copy-in shim adds camera pose, world-space
picks, and replay).

:::caution[Best-effort]
Epic has **no official UE5 HTML5/WASM target** (it was deprecated after UE 4.24) and Pixel
Streaming is server-side (no client-side scene to read). The bridged tier therefore targets
the real, **Emscripten-based, client-side** web exports that do exist — the community
UE4.24–4.27 HTML5 forks ([ufna/UE-HTML5](https://github.com/ufna/UE-HTML5),
[SpeculativeCoder/UnrealEngine-HTML5-ES3](https://github.com/SpeculativeCoder/UnrealEngine-HTML5-ES3))
and the experimental UE5.1–5.4 WASM+WebGPU toolchain (Wonder Interactive / SimplyStream).
All are Emscripten, so the `EM_JS` / `cwrap` shim drops in — but because each target is
experimental or community-maintained, the **bridged tier is best-effort** by design (ADR
0045). The JS-only tier always works.
:::

## Install

```bash
npm install @uptimizr/unreal
```

## Usage

```ts
import { trackUnreal } from "@uptimizr/unreal";

const { client, bridge } = trackUnreal({
  projectId: "your-project",
  endpoint: "https://collect.example.com",
  canvas: () => document.querySelector("#unreal-canvas"),
});

// later, on teardown
await client.stop("manual");
```

`trackUnreal` creates the client, registers the JS-only tier collector, exposes the
engine `bridge` (default `window.__uptimizr_unreal__`), and starts the session with
Unreal's connector provenance. The JS-only tier captures immediately; wire the
engine-side shim to `bridge` to add camera pose, picks, and replay.

## Engine-side bridge

The bridged tier uses a thin **copy-in shim** — Emscripten `EM_JS` / `cwrap` glue that
samples the active `APlayerCameraManager` pose, raycast picks, and FPS each frame and calls
the bridge. It's a copy-in asset, not an npm dependency. The shim ships in the package under
[`bridge/`](https://github.com/RaananW/Uptimizr/blob/main/oss/packages/unreal/bridge/) —
[`Uptimizr.h`](https://github.com/RaananW/Uptimizr/blob/main/oss/packages/unreal/bridge/Uptimizr.h)

- [`Uptimizr.cpp`](https://github.com/RaananW/Uptimizr/blob/main/oss/packages/unreal/bridge/Uptimizr.cpp)
  — alongside a [`README`](https://github.com/RaananW/Uptimizr/blob/main/oss/packages/unreal/bridge/README.md)
  covering the supported web targets and wiring. Copy both files into your project's web
  target, call `UptimizrTelemetry().Initialize()` (which **asserts the bridge protocol version
  matches**), then `UptimizrTelemetry().Tick(GetWorld(), DeltaSeconds)` each frame.

## Coordinate frame

Unreal's native world frame is **left-handed, z-up, centimeters**, so the connector
rebases z-up → y-up, converts cm → m, and reaches the canonical wire frame
(left-handed, y-up, unit scale 1). The engine-side shim pushes **raw Unreal values** —
the connector owns the single normalization path. The session records Unreal's native
frame in `connector.coordinateSystem`.

## Capture

JS-only tier: pointer move/click → screen heatmaps, FPS / long frames → performance,
JS errors. Bridged tier: camera pose → view-direction heatmap, world-space picks →
object engagement, scene proxy, and replay.

## Privacy

No client-side persistent IDs and no PII by default (ADR 0003). `client.stop()` tears
down every listener, timer, and animation-frame callback.

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
Unreal's first-party web export is community-maintained, so the **bridged tier is
best-effort** by design (ADR 0045). The JS-only tier always works.
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

The bridged tier needs a thin **copy-in shim** — Emscripten `EM_JS` glue that samples
the active `APlayerCameraManager` and calls the bridge each frame. It's a copy-in
asset, not an npm dependency. The contract and an `EM_JS` sketch live in the package's
[`bridge/README.md`](https://github.com/RaananW/Uptimizr/blob/main/oss/packages/unreal/bridge/README.md).
The full shim is authored in the Unreal web-export sub-issue.

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

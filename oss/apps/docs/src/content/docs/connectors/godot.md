---
title: Godot
description: Instrument a Godot 4 web export with the @uptimizr/godot connector.
---

The Godot (web export) connector. Godot 4 compiles to WebAssembly and renders into a
`<canvas>`, so it is built on the [web-export foundation](/connectors/web-export) and
works in two tiers: a **JS-only tier** (no engine code — pointer heatmaps, FPS, JS
errors) and a **bridged tier** (a thin copy-in shim adds camera pose, world-space
picks, and replay).

## Install

```bash
npm install @uptimizr/godot
```

## Usage

```ts
import { trackGodot } from "@uptimizr/godot";

const { client, bridge } = trackGodot({
  projectId: "your-project",
  endpoint: "https://collect.example.com",
  canvas: () => document.querySelector("#godot-canvas"),
});

// later, on teardown
await client.stop("manual");
```

`trackGodot` creates the client, registers the JS-only tier collector, exposes the
engine `bridge` (default `window.__uptimizr_godot__`), and starts the session with
Godot's connector provenance. The JS-only tier captures immediately; wire the
engine-side shim to `bridge` to add camera pose, picks, and replay.

## Engine-side bridge

The bridged tier needs a thin **copy-in shim** — a `JavaScriptBridge` autoload that
samples the active `Camera3D` and calls the bridge each frame. It ships with the package as
a copy-in asset (not an npm dependency), in both GDScript and C#:

1. Copy [`UptimizrGodot.gd`](https://github.com/RaananW/Uptimizr/blob/main/oss/packages/godot/bridge/UptimizrGodot.gd)
   (or [`UptimizrGodot.cs`](https://github.com/RaananW/Uptimizr/blob/main/oss/packages/godot/bridge/UptimizrGodot.cs)
   for .NET projects) into your Godot 4 project.
2. Register it as a singleton: **Project → Project Settings → Globals → Autoload**, add the
   script with node name `UptimizrGodot`, and enable it.

On the next Web export the autoload finds `window.__uptimizr_godot__` (exposed by
`trackGodot`), asserts the bridge protocol version, and starts pushing camera pose, FPS, and
left-click raycast picks automatically. Off the Web export it guards on
`OS.has_feature("web")` and is a no-op, so it is safe to leave enabled in every build.

For world-space object engagement and replay completeness, mark nodes with
`add_to_group("uptimizr_tracked")` and call `UptimizrGodot.push_scene_proxy()` once after
your scene is built. The full contract, options, and coordinate notes live in the package's
[`bridge/README.md`](https://github.com/RaananW/Uptimizr/blob/main/oss/packages/godot/bridge/README.md).

## Coordinate frame

Godot's native world frame is **right-handed, y-up, meters**, so the connector negates
Z to reach the canonical wire frame (left-handed, y-up). The engine-side shim does no
coordinate math. The session records Godot's native frame in
`connector.coordinateSystem`.

## Capture

JS-only tier: pointer move/click → screen heatmaps, FPS / long frames → performance,
JS errors. Bridged tier: camera pose → view-direction heatmap, world-space picks →
object engagement, scene proxy, and replay.

## Privacy

No client-side persistent IDs and no PII by default (ADR 0003). `client.stop()` tears
down every listener, timer, and animation-frame callback.

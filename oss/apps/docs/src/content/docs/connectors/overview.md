---
title: Connectors overview
description: How Uptimizr connectors work, which engines are supported, and what they all capture.
---

A **connector** is the engine-specific adapter that observes your 3D scene and emits events. Every
connector registers as a collector on `@uptimizr/sdk-core`, captures the same channels, and emits
the same versioned event schema — so heatmaps, rankings, and replay behave identically no matter
which renderer you use.

## Supported engines

| Engine            | Package                  | Status      | Entry point                              |
| ----------------- | ------------------------ | ----------- | ---------------------------------------- |
| Babylon.js        | `@uptimizr/babylon`      | Stable      | `trackScene(scene, …)`                   |
| Babylon Lite      | `@uptimizr/babylon-lite` | Stable      | `trackScene(scene, camera, canvas, …)`   |
| three.js          | `@uptimizr/three`        | Stable      | `trackScene(scene, camera, renderer, …)` |
| PlayCanvas        | `@uptimizr/playcanvas`   | Beta        | `trackScene(app, camera, …)`             |
| react-three-fiber | `@uptimizr/r3f`          | Beta        | `<Uptimizr />` / `useUptimizr()`         |
| A-Frame           | `@uptimizr/aframe`       | Beta        | `uptimizr` HTML component                |
| Unity (WebGL)     | `@uptimizr/unity`        | Beta        | `trackUnity(…)`                          |
| Godot (web)       | `@uptimizr/godot`        | Beta        | `trackGodot(…)`                          |
| Unreal (web)      | `@uptimizr/unreal`       | Best-effort | `trackUnreal(…)`                         |

> **Web-export engines** (Unity, Godot, Unreal) compile to WebAssembly and render into a `<canvas>`,
> so there is no live JS scene to read. They share the [`@uptimizr/web-export`](/connectors/web-export)
> foundation and capture in **two tiers**: a **JS-only tier** (pointer heatmaps, FPS, JS errors — no
> engine code) and a **bridged tier** (camera pose, world-space picks, replay — via a thin copy-in
> engine-side shim). For these, the engine is **not** an npm peer dependency.

## What every connector captures

- **Camera pose** (position + forward direction) → view-direction heatmap
- **Pointer move / click** (normalized screen + optional raycast hit) → screen & world heatmaps
- **Mesh picks** → object-engagement analytics
- **FPS / frame perf** → performance
- **Mesh visibility**, **hover dwell**, **resource sample** (opt-in) → attention & footprint

## Asset-load capture (`asset_load`)

The `asset_load` event reports per-asset load timing (`name`, `loadMs`, optional `bytes`/`ttffMs`/
`ttiMs`). Whether a connector captures it **automatically** depends on the engine exposing a global
load lifecycle to hook. Engines without an always-on asset registry can still report `asset_load`
**from your app** by emitting it on the `UptimizrClient` directly.

| Engine            | `asset_load` capture | How                                                                                  |
| ----------------- | -------------------- | ------------------------------------------------------------------------------------ |
| PlayCanvas        | ✅ Automatic         | Hooks the `app.assets` registry lifecycle (`load:start` → `load` / `error`).         |
| Babylon.js        | ⚙️ App-reported      | `SceneLoader` / `AssetsManager` are per-call — no always-on global registry to hook. |
| Babylon Lite      | ⚙️ App-reported      | Same as Babylon.js.                                                                  |
| three.js          | ⚙️ App-reported      | `LoadingManager` is per-loader and optional — no guaranteed global hook.             |
| react-three-fiber | ⚙️ App-reported      | Wraps three.js; same as three.js.                                                    |
| A-Frame           | ⚙️ App-reported      | Wraps three.js; same as three.js.                                                    |

Privacy (ADR 0003): the PlayCanvas connector records only the asset's app-defined **name**, never the
file URL. Disable it with `capture: { assetLoad: false }`.

## Shared principles

- **The engine is a peer dependency.** Connectors read your existing engine instance and never
  bundle or mutate the scene.
- **Clean teardown.** Calling `dispose()` / `stop()` removes every DOM listener, timer, and
  animation-frame callback. No cookies, no persistent IDs.
- **Canonical coordinate frame.** World-space data is normalized to Uptimizr's canonical wire frame
  (left-handed, y-up) at the emission boundary, while `connector.coordinateSystem` records the
  engine's native frame for provenance.
- **Same options everywhere.** Capture fidelity (`sampling`), channel toggles (`capture`), scene
  actors, and opt-in channels work the same across connectors. Engine differences are only in how
  you hand the scene/camera/renderer to `trackScene`.

## Advanced setup

Every connector's one-call `trackScene` returns an `@uptimizr/sdk-core` `UptimizrClient`. For a
custom transport, a `beforeSend` hook, or registering multiple collectors on one session, compose
the pieces yourself — see [sdk-core (advanced)](/docs/connectors/sdk-core/).

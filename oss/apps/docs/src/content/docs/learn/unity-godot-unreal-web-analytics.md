---
title: Analytics for Unity, Godot and Unreal web exports
description: Add heatmaps, FPS tracking and replay to Unity WebGL, Godot and Unreal web exports. See what you get with no engine code and what needs a small bridge.
lastUpdated: 2026-11-06
---

Unity, Godot and Unreal web exports compile to WebAssembly and render into a `<canvas>`, so there's no
JavaScript scene for an analytics tool to read. Uptimizr handles this in two tiers: a JavaScript tier
that works immediately with no engine changes, and a bridged tier that adds world-space data through a
small shim you copy into your project.

:::note[Web exports only]
Uptimizr measures 3D on the web. Native desktop, mobile, console and headset builds aren't supported.
:::

## What each tier captures

| Tier    | Engine code?         | What you get                                                                    |
| ------- | -------------------- | ------------------------------------------------------------------------------- |
| JS-only | None                 | Pointer and click heatmaps, FPS and long frames, opt-in JS errors               |
| Bridged | A small copy-in shim | Camera pose and view-direction heatmaps, world-space picks, scene proxy, replay |

Start with the JS-only tier. It tells you whether people engage with the export and how it performs,
and you can add the bridge later if you need to know what they looked at.

## Support by engine

| Engine        | Package            | Status | Bridged tier                                                 |
| ------------- | ------------------ | ------ | ------------------------------------------------------------ |
| Unity WebGL   | `@uptimizr/unity`  | Beta   | Preview, using a `.jslib` plugin and a small `MonoBehaviour` |
| Godot 4 (web) | `@uptimizr/godot`  | Beta   | Available through a copy-in shim                             |
| Unreal (web)  | `@uptimizr/unreal` | Alpha  | Best-effort, for experimental or community web exports       |

Unreal needs extra care: Epic has no official UE5 HTML5 or WebAssembly target, and Pixel Streaming
runs on a server, so there's no client-side scene to read. The JS-only tier works with any Unreal
canvas, while the bridged tier targets community and experimental Emscripten exports. See the
[Unreal page](/docs/connectors/unreal/) for the toolchains involved.

## Add the JS-only tier

Start the connector on the page that hosts your export, before the export boots. This Unity example
looks the same for `trackGodot` and `trackUnreal`:

```bash
npm install @uptimizr/unity
```

```ts
import { trackUnity } from "@uptimizr/unity";

const { client, bridge } = trackUnity({
  projectId: "your-project",
  endpoint: "https://collect.example.com",
  canvas: () => document.querySelector("#unity-canvas"),
});
```

Data starts flowing straight away. The endpoint is a
[collector you run yourself](/docs/deploy/collector/).

## Add the bridged tier

The bridge is a copy-in asset, not a package, and it does no coordinate maths. It sends your engine's
own world-space values to the connector, which normalizes them. For Unity:

1. Copy `Uptimizr.jslib` to `Assets/Plugins/WebGL/` in your project.
2. Copy `UptimizrUnityBridge.cs` under `Assets/` and add the component to a GameObject.
3. Make sure `trackUnity(...)` runs on the host page before the export starts.

See the setup for [Unity](/docs/connectors/unity/), [Godot](/docs/connectors/godot/) and
[Unreal](/docs/connectors/unreal/).

## Other WebAssembly engines

If your engine renders to a `<canvas>` from WebAssembly, you can use the shared
[`@uptimizr/web-export`](/docs/connectors/web-export/) foundation directly. You supply the engine's
native coordinate frame and get both tiers.

## Next steps

- Read about [web exports](/docs/connectors/web-export/) and the bridge contract.
- Follow [Run the collector](/docs/deploy/collector/) to self-host the backend.
- Explore the reports in the [live demo](https://demo.uptimizr.com).

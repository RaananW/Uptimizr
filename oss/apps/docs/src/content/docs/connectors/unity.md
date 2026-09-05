---
title: Unity
description: Instrument a Unity WebGL export with the @uptimizr/unity connector.
---

The Unity (WebGL export) connector. Unity compiles to WebAssembly and renders into a
`<canvas>`, so it is built on the [web-export foundation](/connectors/web-export) and
works in two tiers: a **JS-only tier** (no engine code — pointer heatmaps, FPS, JS
errors) and a **bridged tier** (a thin copy-in shim adds camera pose, world-space
picks, and replay).

:::note[Status]
The JS-only tier is covered end to end by the Playwright suite. The bridged tier is
**preview**: the `.jslib` shim is sanity-tested on every `pnpm test`, and the full round
trip through a real Unity WebGL export runs against a **local build** of the sample
project — it is labelled **verified against a local build** once a maintainer has run
that spec. See [Verifying against a real export](#verifying-against-a-real-export).
:::

## Install

```bash
npm install @uptimizr/unity
```

## Usage

```ts
import { trackUnity } from "@uptimizr/unity";

const { client, bridge } = trackUnity({
  projectId: "your-project",
  endpoint: "https://collect.example.com",
  canvas: () => document.querySelector("#unity-canvas"),
});

// later, on teardown
await client.stop("manual");
```

`trackUnity` creates the client, registers the JS-only tier collector, exposes the
engine `bridge` (default `window.__uptimizr_unity__`), and starts the session with
Unity's connector provenance. The JS-only tier captures immediately; wire the
engine-side shim to `bridge` to add camera pose, picks, and replay.

## Engine-side bridge

The bridged tier needs a thin **copy-in shim** — a `.jslib` plugin plus a small
`MonoBehaviour` that samples the active `Camera`, raycast picks, and FPS and calls the
bridge. It's a copy-in asset, not an npm dependency, and it does **no** coordinate math
— it pushes Unity's own world-space values and the connector normalizes them. Both files
live in the package's
[`bridge/`](https://github.com/RaananW/Uptimizr/tree/main/oss/packages/unity/bridge)
folder.

Set up:

1. Copy **`Uptimizr.jslib`** to `Assets/Plugins/WebGL/Uptimizr.jslib` in your Unity
   project (Unity compiles `.jslib` files under `Plugins/WebGL` into the WebGL build).
2. Copy **`UptimizrUnityBridge.cs`** anywhere under `Assets/` and add the
   `UptimizrUnityBridge` component to a GameObject. It defaults to `Camera.main`; assign
   a specific `Camera` if you prefer.
3. Make sure `trackUnity(...)` (or `client.use(unityCollector())`) runs on the host page
   **before** the export starts, so `window.__uptimizr_unity__` exists.

On `Start()`, the component asserts the bridge protocol version matches the foundation's
`BRIDGE_PROTOCOL_VERSION` (1) and disables itself with a warning if the connector is
missing or a different version. The shim's JS API:

| `.jslib` function                 | Bridge call       | Notes                                             |
| --------------------------------- | ----------------- | ------------------------------------------------- |
| `UptimizrUnityGetProtocolVersion` | `protocolVersion` | `-1` when the connector isn't present yet.        |
| `UptimizrUnityPushPose`           | `pushPose`        | Position / forward / up + vertical FOV (radians). |
| `UptimizrUnityPushPick`           | `pushPick`        | Named object + world hit point.                   |
| `UptimizrUnityPushPerf`           | `pushPerf`        | FPS + long frames.                                |
| `UptimizrUnitySetSceneProxy`      | `setSceneProxy`   | JSON array of `{ name, aabb[6] }` nodes.          |

See [`bridge/README.md`](https://github.com/RaananW/Uptimizr/blob/main/oss/packages/unity/bridge/README.md)
for the full contract.

## Verifying against a real export

Unity is not part of the JS toolchain, so verification is split in two:

- **Always on (CI).** A `node:vm` sanity test evaluates `Uptimizr.jslib` with mocked
  Emscripten globals and asserts every export forwards to `window.__uptimizr_unity__`,
  declares its `__deps`, and matches the `[DllImport]`s in `UptimizrUnityBridge.cs`.
- **One manual step.** The sample project
  [`examples/unity-web-export/`](https://github.com/RaananW/Uptimizr/tree/main/examples/unity-web-export)
  (Unity 2022.3 LTS) ships a scene with a camera and three named cubes, the bridge
  files already in place, and player settings pre-set to **Compression Format:
  Disabled** so the output serves from a plain static server. Open it in Unity Hub,
  **File → Build Settings → WebGL → Build** into `examples/unity-web-export/dist/`, then
  run the Playwright spec:

  ```bash
  pnpm --filter @uptimizr/example-playground exec playwright test unity-export
  ```

  The harness page starts `trackUnity(...)` **before** `createUnityInstance` (so the
  bridge global exists when the C# `Start()` runs), clicks the centre cube, and asserts
  `session_start.connector.name === "unity"`, `camera_sample`, `mesh_interaction`, and
  `frame_perf` reach the collector. Without a build the spec skips — the CI default.

Any WebGL template works as long as it does not stop the host page from adding its own
scripts; the spec bypasses Unity's generated `index.html` and loads `Build/*.loader.js`
itself.

## Coordinate frame

Unity's native world frame is **left-handed, y-up, meters** — already Uptimizr's
canonical wire frame, so world-space payloads need no axis conversion. The session
records Unity's native frame in `connector.coordinateSystem`.

## Capture

JS-only tier: pointer move/click → screen heatmaps, FPS / long frames → performance,
JS errors. Bridged tier: camera pose → view-direction heatmap, world-space picks →
object engagement, scene proxy, and replay.

## Privacy

No client-side persistent IDs and no PII by default (ADR 0003). `client.stop()` tears
down every listener, timer, and animation-frame callback.

# Unity engine-side bridge (copy-in asset)

The **bridged tier** of the [`@uptimizr/unity`](../) connector (ADR 0045). Unity compiles
to WebAssembly and renders into a `<canvas>`, so its scene graph lives in WASM linear
memory and JS cannot read the camera or raycast it passively (unlike the Babylon adapter).
This folder is the thin **engine-side shim** that pushes that data across the JS interop
boundary to the connector.

> The **JS-only tier** (pointer heatmaps + FPS + JS errors) works with **no** engine code
> — it reads the `<canvas>` DOM directly. You only need this bridge for the 3D-native
> channels: camera-pose / view-direction heatmap, world-space picks, scene proxy, and
> replay.

These are **copy-in assets**, not an npm package. They carry **no** analytics logic, IDs,
or schema knowledge — they only forward Unity's own camera/raycast/perf to the versioned
JS bridge the connector exposes on `window.__uptimizr_unity__`.

## Files

| File                                                 | What it is                                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [`Uptimizr.jslib`](./Uptimizr.jslib)                 | Emscripten plugin (`mergeInto(LibraryManager.library, …)`) the C# side calls into.      |
| [`UptimizrUnityBridge.cs`](./UptimizrUnityBridge.cs) | Example `MonoBehaviour` that samples the active `Camera`, picks, and FPS each interval. |

## Install

1. Copy **`Uptimizr.jslib`** to `Assets/Plugins/WebGL/Uptimizr.jslib` in your Unity
   project. (Unity compiles `.jslib` files under `Plugins/WebGL` into the WebGL build.)
2. Copy **`UptimizrUnityBridge.cs`** anywhere under `Assets/` and add the
   `UptimizrUnityBridge` component to a GameObject in your scene (e.g. an empty
   `Uptimizr` object). Optionally assign a specific `Camera`; it defaults to
   `Camera.main`.
3. On the **host page** (the HTML that loads your WebGL export), register the connector
   so `window.__uptimizr_unity__` exists before the export starts pushing:

   ```ts
   import { trackUnity } from "@uptimizr/unity";

   trackUnity({
     projectId: "your-project",
     endpoint: "https://collect.example.com",
     canvas: () => document.querySelector("#unity-canvas"),
   });
   ```

On `Start()`, the component asserts the bridge protocol version matches
`BRIDGE_PROTOCOL_VERSION` (1). If the connector is missing or a different version, it logs
a warning and disables itself rather than pushing to an incompatible bridge.

## The JS API the shim calls

The connector exposes an `EngineBridge` on `window.__uptimizr_unity__` (configurable via
the `bridgeGlobal` option). The `.jslib` plugin forwards to it. **All values are
world-space in Unity's native frame** — left-handed, y-up, meters, which is already
Uptimizr's canonical wire frame, so the connector applies the **identity** normalization
for Unity. The shim does **no** coordinate math.

```ts
interface EngineBridge {
  readonly protocolVersion: number; // assert === BRIDGE_PROTOCOL_VERSION (1)
  pushPose(position: Vec3, forward: Vec3, up: Vec3, fov?: number): void; // fov in radians
  pushPick(objectName: string, hitPoint: Vec3): void;
  pushPerf(fps: number, longFrames?: number): void;
  setSceneProxy(
    nodes: { name: string; aabb: [number, number, number, number, number, number] }[],
  ): void;
  dispose(): void;
}
```

The `.jslib` exposes these to C# (called via `[DllImport("__Internal")]`):

| `.jslib` function                 | Maps to           | Notes                                                                        |
| --------------------------------- | ----------------- | ---------------------------------------------------------------------------- |
| `UptimizrUnityGetProtocolVersion` | `protocolVersion` | Returns the version, or `-1` if the connector isn't present yet.             |
| `UptimizrUnityPushPose`           | `pushPose`        | 9 floats + `fov` (radians); pass `fov < 0` to omit it.                       |
| `UptimizrUnityPushPick`           | `pushPick`        | UTF-8 object name + 3 floats (world hit point).                              |
| `UptimizrUnityPushPerf`           | `pushPerf`        | `fps` + `longFrames` (`< 0` to omit).                                        |
| `UptimizrUnitySetSceneProxy`      | `setSceneProxy`   | A JSON string of `{ name, aabb[6] }` nodes (arrays don't cross `DllImport`). |

## Privacy (ADR 0003)

The shim transmits only low-cardinality, non-PII telemetry: poses, FPS, and
developer-assigned **named** objects (the GameObject name that was hit). It MUST NOT
invent identifiers or forward raw input text — the pick channel sends an object name and a
world point, never pointer coordinates as text or keystrokes.

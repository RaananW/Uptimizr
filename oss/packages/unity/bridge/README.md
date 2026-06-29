# Unity engine-side bridge (copy-in asset)

> **Status: placeholder.** The full Unity shim is authored in the Unity web-export
> connector sub-issue (see umbrella issue #111). This folder documents the contract
> the shim must satisfy so the bridged tier (camera pose / world-space picks /
> replay) drops in. The **JS-only tier** (pointer heatmaps + FPS + errors) already
> works with **no** engine code.

## What the shim is

A small, dumb shim that ships as a **copy-in asset** (not an npm package) and pushes
per-sample telemetry from Unity's C# side across the JS interop boundary to the
browser-side `@uptimizr/unity` connector. It carries **no** analytics logic, IDs, or
schema knowledge (ADR 0045).

For Unity WebGL this is:

- a `.jslib` plugin (Emscripten) under `Assets/Plugins/WebGL/` exposing functions the
  C# side invokes via `[DllImport("__Internal")]`, and
- a small `MonoBehaviour` that reads the active `Camera`, raycast hits, and
  `Time`/FPS each sample and calls those functions.

## The JS API the shim calls

The connector exposes an `EngineBridge` on `window.__uptimizr_unity__` (configurable
via the `bridgeGlobal` option). The `.jslib` plugin calls it. **All values are
world-space in Unity's native frame** (left-handed, y-up, meters — already
canonical); the connector normalizes and emits the schema events.

```ts
interface EngineBridge {
  readonly protocolVersion: number; // assert against BRIDGE_PROTOCOL_VERSION (1)
  pushPose(position: [x, y, z], forward: [x, y, z], up: [x, y, z], fov?: number): void;
  pushPick(objectName: string, hitPoint: [x, y, z]): void;
  pushPerf(fps: number, longFrames?: number): void;
  setSceneProxy(nodes: { name: string; aabb: [minX, minY, minZ, maxX, maxY, maxZ] }[]): void;
  dispose(): void;
}
```

### `.jslib` sketch (illustrative — full version lands in the sub-issue)

```c
mergeInto(LibraryManager.library, {
  UptimizrPushPose: function (px, py, pz, fx, fy, fz, ux, uy, uz, fov) {
    var b = window.__uptimizr_unity__;
    if (b) b.pushPose([px, py, pz], [fx, fy, fz], [ux, uy, uz], fov);
  },
  UptimizrPushPerf: function (fps, longFrames) {
    var b = window.__uptimizr_unity__;
    if (b) b.pushPerf(fps, longFrames);
  }
});
```

```csharp
using System.Runtime.InteropServices;
public class UptimizrBridge : MonoBehaviour {
  [DllImport("__Internal")] static extern void UptimizrPushPose(
    float px, float py, float pz, float fx, float fy, float fz,
    float ux, float uy, float uz, float fov);
  // ... sample the active Camera each interval and call UptimizrPushPose(...)
}
```

## Privacy (ADR 0003)

The shim transmits only low-cardinality, non-PII telemetry: poses, FPS, and
developer-assigned **named** objects. It MUST NOT invent identifiers or forward raw
input text.

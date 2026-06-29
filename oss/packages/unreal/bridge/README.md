# Unreal engine-side bridge (copy-in asset)

> **Status: placeholder.** The full Unreal shim is authored in the Unreal web-export
> connector sub-issue (see umbrella issue #111). This folder documents the contract
> the shim must satisfy so the bridged tier (camera pose / world-space picks /
> replay) drops in. The **JS-only tier** (pointer heatmaps + FPS + errors) already
> works with **no** engine code.

## What the shim is

A small, dumb shim that ships as a **copy-in asset** (not an npm package) and pushes
per-sample telemetry from an Unreal HTML5/web export across the JS interop boundary
to the browser-side `@uptimizr/unreal` connector. It carries **no** analytics logic,
IDs, or schema knowledge (ADR 0045).

Unreal's first-party web export is **best-effort / community-maintained**, so this
connector is best-effort by design (see ADR 0045). The shim is Emscripten glue —
`EM_JS`/`emscripten_run_script` from C++ (or a small JS plugin called via `cwrap`)
that samples the active `APlayerCameraManager`, hit results, and FPS each frame.

## The JS API the shim calls

The connector exposes an `EngineBridge` on `window.__uptimizr_unreal__` (configurable
via the `bridgeGlobal` option). **All values are world-space in Unreal's native
frame** (left-handed, **z-up**, **centimeters**); the connector rebases z-up → y-up,
converts cm → m, and flips handedness to reach the canonical wire frame and emits the
schema events — the shim does **no** coordinate math.

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

### `EM_JS` sketch (illustrative — full version lands in the sub-issue)

```cpp
EM_JS(void, UptimizrPushPose, (double px, double py, double pz,
                               double fx, double fy, double fz,
                               double ux, double uy, double uz, double fov), {
  var b = window.__uptimizr_unreal__;
  if (b) b.pushPose([px, py, pz], [fx, fy, fz], [ux, uy, uz], fov);
});

// Each frame: read APlayerCameraManager location/rotation (cm, z-up) and call
// UptimizrPushPose(loc.X, loc.Y, loc.Z, fwd.X, fwd.Y, fwd.Z, up.X, up.Y, up.Z, fov);
```

> Pass raw Unreal values — **centimeters, z-up, left-handed**. Do **not** pre-convert;
> the connector owns the single normalization path so every engine stays consistent.

## Privacy (ADR 0003)

The shim transmits only low-cardinality, non-PII telemetry: poses, FPS, and
developer-assigned **named** objects. It MUST NOT invent identifiers or forward raw
input text.

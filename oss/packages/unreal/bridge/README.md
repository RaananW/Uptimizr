# Unreal engine-side bridge (copy-in asset)

> **Status: shim provided, best-effort.** This folder ships the actual Emscripten
> shim — [`Uptimizr.h`](./Uptimizr.h) + [`Uptimizr.cpp`](./Uptimizr.cpp) — that
> pushes camera pose / world-space picks / FPS over the versioned bridge. The
> **JS-only tier** (pointer heatmaps + FPS + errors) already works with **no** engine
> code; this shim adds the 3D-native (bridged) tier.

## What the shim is

A small, dumb shim that ships as a **copy-in asset** (not an npm package) and pushes
per-sample telemetry from an Unreal web export across the JS interop boundary to the
browser-side `@uptimizr/unreal` connector. It carries **no** analytics logic, IDs, or
schema knowledge (ADR 0045). It performs **no** coordinate math — it pushes Unreal's
RAW world-space values and the connector owns the single normalization path.

## Feasibility — which web targets this works on (issue #112)

Epic has **no official UE5 HTML5/WASM target** (it was deprecated after UE 4.24), and
Pixel Streaming is **server-side** rendering (no client WASM scene to read), so neither
fits this model. The shim instead targets the real, **Emscripten-based, client-side**
web exports that render into a `<canvas>` and expose the `EM_JS` / `cwrap` interop seam:

| Target                                                                                                                                                                           | UE versions | Renderer      | Status               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------- | -------------------- |
| Community HTML5 forks ([ufna/UE-HTML5](https://github.com/ufna/UE-HTML5), [SpeculativeCoder/UnrealEngine-HTML5-ES3](https://github.com/SpeculativeCoder/UnrealEngine-HTML5-ES3)) | 4.24–4.27   | WebGL2        | community-maintained |
| [Wonder Interactive / SimplyStream](https://wonderinteractive.com/)                                                                                                              | 5.1–5.4     | WASM + WebGPU | experimental         |

Both are Emscripten, so the `EM_JS` / `cwrap` glue below is available by construction.
Because every viable target is experimental or community-maintained, the **bridged tier
is best-effort by design** (ADR 0045); the JS-only tier always works. Outside Emscripten
(e.g. the desktop editor) every entry point compiles to a no-op, so the shim is safe to
leave wired in across all your build targets.

## The JS API the shim calls

The connector exposes an `EngineBridge` on `window.__uptimizr_unreal__` (configurable via
the `bridgeGlobal` option). **All values are world-space in Unreal's native frame**
(left-handed, **z-up**, **centimeters**); the connector rebases z-up → y-up, converts
cm → m, and reaches the canonical wire frame, then emits the schema events — the shim does
**no** coordinate math.

```ts
interface EngineBridge {
  readonly protocolVersion: number; // assert against UPTIMIZR_BRIDGE_PROTOCOL_VERSION (1)
  pushPose(position: [x, y, z], forward: [x, y, z], up: [x, y, z], fov?: number): void;
  pushPick(objectName: string, hitPoint: [x, y, z]): void;
  pushPerf(fps: number, longFrames?: number): void;
  setSceneProxy(nodes: { name: string; aabb: [minX, minY, minZ, maxX, maxY, maxZ] }[]): void;
  dispose(): void;
}
```

## Wiring it in

1. Copy `Uptimizr.h` + `Uptimizr.cpp` into your project's `Source/<Module>/` (or a
   plugin), so they build with your **web** target.
2. Load `@uptimizr/unreal` in the export's host page and call `trackUnreal({...})` (or
   register `unrealCollector()`), which attaches the bridge to `window.__uptimizr_unreal__`.
3. Once both are up, initialize the sampler. `Initialize()` reads the live bridge's
   `protocolVersion` and **asserts it equals `UPTIMIZR_BRIDGE_PROTOCOL_VERSION` (1)** —
   it stays disabled on a mismatch rather than push against an incompatible API. Drive it
   from C++:

   ```cpp
   #include "Uptimizr.h"

   // once, after the page + connector are ready:
   UptimizrTelemetry().Initialize();

   // every frame (e.g. from an AActor::Tick or a UActorComponent::TickComponent):
   UptimizrTelemetry().Tick(GetWorld(), DeltaSeconds);

   // from your own click/interaction handler (or let it line-trace for you):
   UptimizrTelemetry().TraceAndReportPick(GetWorld());
   ```

   …or drive `Init` / `Shutdown` from JS by symbol via `cwrap`
   (`Module.cwrap('UptimizrBridge_Init', 'number', [])`).

`Tick` reads the active `APlayerCameraManager` pose and accumulates FPS, pushing a pose
every frame and a perf sample about once per second — all as **raw centimeters, z-up,
left-handed** values.

### `EM_JS` sketch (the shim implements the full version)

```cpp
EM_JS(void, UptimizrPushPoseJS, (double px, double py, double pz,
                                 double fx, double fy, double fz,
                                 double ux, double uy, double uz, double fov), {
  var b = window.__uptimizr_unreal__;
  if (b) b.pushPose([px, py, pz], [fx, fy, fz], [ux, uy, uz], fov);
});

// Each frame: read APlayerCameraManager location/rotation (cm, z-up) and call
// UptimizrPushPoseJS(loc.X, loc.Y, loc.Z, fwd.X, fwd.Y, fwd.Z, up.X, up.Y, up.Z, fovRad);
```

> Pass raw Unreal values — **centimeters, z-up, left-handed**. Do **not** pre-convert;
> the connector owns the single normalization path so every engine stays consistent.

## Privacy (ADR 0003)

The shim transmits only low-cardinality, non-PII telemetry: poses, FPS, and
developer-assigned **named** objects (the picked actor's `GetName()`). It MUST NOT invent
identifiers or forward raw input text.

# @uptimizr/web-export

The shared foundation for Uptimizr's **web-export engine connectors** — Unity, Godot,
and Unreal (ADR 0045). These engines compile to WebAssembly and render into a
`<canvas>`, so there is **no live JS scene to read**. This package provides the three
reusable pieces every web-export connector is built from:

1. **A versioned JS bridge contract** (`createEngineBridge`, `EngineBridge`,
   `BRIDGE_PROTOCOL_VERSION`) — the tiny, stable API a thin engine-side shim calls to
   push world-space **pose / picks / perf / scene-proxy** across the WASM↔JS boundary.
2. **A JS-only (zero-engine-code) capture tier** (`startJsOnlyCapture`) — pointer
   move/click heatmaps, `requestAnimationFrame` FPS + long-frame perf, and
   `error`/`unhandledrejection` capture, driven purely from the canvas DOM. No engine
   memory read; works for **any** web export with no engine changes.
3. **Native-frame normalization** (`normalizePosition`, `normalizeDirection`,
   `normalizeAabb`, `rebaseZUpToYUp`) — converts each engine's world-space data to the
   canonical wire frame (**left-handed, y-up, unit scale 1** — ADR 0018), including
   the Unreal **z-up → y-up** rebase and **centimeter → meter** scale.

Plus `webExportCollector` (the combined [`@uptimizr/sdk-core`](../sdk-core) collector)
and `trackWebExport` (one-call setup). **No `@uptimizr/schema` change is required** —
connectors emit only existing events.

Most of the time you don't depend on this directly — use `@uptimizr/unity`,
`@uptimizr/godot`, or `@uptimizr/unreal`, which bake in their engine's native frame and
connector name.

## When to use this directly

Reach for `@uptimizr/web-export` itself when:

- **Your engine isn't one we ship a package for** — Wonderland, a Bevy/Rust `wasm`
  build, Stride, or any in-house Emscripten/WebAssembly renderer that draws to a
  `<canvas>`. Supply its native `frame` (`handedness` / `upAxis` / `unitScale`) and get
  both tiers for free.
- **The native frame is configurable or only known at runtime** — pass `frame`
  dynamically instead of a hard-coded one.
- **You only want the JS-only tier on any canvas app** — pointer heatmaps, FPS, and JS
  errors with zero engine code. Use `trackWebExport`, or `startJsOnlyCapture` for the
  bare primitive.
- **You need custom bridge wiring** — `createEngineBridge` and the normalization helpers
  (`normalizePosition`, `normalizeDirection`, `normalizeAabb`, `rebaseZUpToYUp`) for a
  bespoke transport, a server-side normalization step, or tests.
- **You're authoring a new connector package** — a new `@uptimizr/<engine>` wraps this,
  exactly as `@uptimizr/unity` does.

If you're on Unity, Godot, or Unreal, prefer the engine package — it fixes the correct
native frame, sets the connector provenance name, and exposes the
`window.__uptimizr_<engine>__` global the matching copy-in shim expects.

## Install

```bash
npm install @uptimizr/web-export
```

## The two capture tiers

| Tier        | Engine code?        | Captures                                                                     |
| ----------- | ------------------- | ---------------------------------------------------------------------------- |
| **JS-only** | none                | pointer move/click heatmaps, FPS / long frames, JS errors                    |
| **Bridged** | a thin copy-in shim | camera pose → view-direction heatmap, world-space picks, scene proxy, replay |

The JS-only tier is live the moment you call `trackWebExport`. The bridged tier
activates when an engine-side shim starts calling the returned `bridge`.

## Usage

```ts
import { trackWebExport } from "@uptimizr/web-export";

const { client, bridge } = trackWebExport({
  projectId: "your-project",
  endpoint: "https://collect.example.com",
  name: "my-engine",
  frame: { handedness: "right", upAxis: "z", unitScale: 100 }, // example native frame
  canvas: () => document.querySelector("canvas"),
});

// The engine-side shim pushes world-space samples in the engine's native frame:
bridge?.pushPose([0, 1.6, 0], [0, 0, 1], [0, 1, 0], Math.PI / 3);
bridge?.pushPerf(60);

// ... later, on teardown
await client.stop("manual");
```

`bridge` is also exposed on `window` (default `window.__uptimizr_my-engine__`,
configurable via `bridgeGlobal`) so a WASM shim can find it by global name.

### The bridge contract

```ts
interface EngineBridge {
  readonly protocolVersion: number; // === BRIDGE_PROTOCOL_VERSION
  pushPose(position: [x, y, z], forward: [x, y, z], up: [x, y, z], fov?: number): void;
  pushPick(objectName: string, hitPoint: [x, y, z]): void;
  pushPerf(fps: number, longFrames?: number): void;
  setSceneProxy(nodes: { name: string; aabb: [minX, minY, minZ, maxX, maxY, maxZ] }[]): void;
  dispose(): void;
}
```

All inputs are **world-space in the engine's native frame** — the connector owns the
single normalization path, so the shim does no coordinate math.

## Privacy

No client-side persistent IDs and no PII by default (ADR 0003). The JS-only tier
records pointer positions and FPS; the bridge records poses and developer-assigned
**named** objects. `dispose()` / `client.stop()` tears down every listener, timer, and
animation-frame callback.

## License

Apache-2.0.

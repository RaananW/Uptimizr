# AGENTS.md — @uptimizr/web-export

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

The shared foundation for Uptimizr's **web-export engine connectors** — Unity, Godot and Unreal
(ADR 0045). These engines compile to WebAssembly and render into a `<canvas>`, so **there is no
live JS scene to duck-type**: the scene graph lives in WASM linear memory with no stable ABI. The
connector model is therefore split in two, and this package supplies the three reusable pieces:

1. **A versioned JS bridge contract** (`createEngineBridge`, `EngineBridge`,
   `BRIDGE_PROTOCOL_VERSION`) — the tiny, stable API a thin engine-side shim calls to push
   world-space **pose / picks / perf / scene-proxy** across the WASM↔JS boundary.
2. **A JS-only (zero-engine-code) capture tier** (`startJsOnlyCapture`) — pointer move/click
   heatmaps, `requestAnimationFrame` FPS + long-frame perf, and `error` / `unhandledrejection`
   capture, driven purely from the canvas DOM.
3. **Native-frame normalization** (`normalizePosition`, `normalizeDirection`, `normalizeAabb`,
   `rebaseZUpToYUp`) — converts each engine's world-space data to the canonical wire frame
   (**left-handed, y-up, unit scale 1** — ADR 0018), including Unreal's z-up → y-up rebase and
   centimeter → meter scale.

Plus `webExportCollector` (the combined `@uptimizr/sdk-core` collector) and `trackWebExport`
(one-call setup). **No `@uptimizr/schema` change is required** — connectors emit only existing
events.

If you are on Unity, Godot or Unreal, use `@uptimizr/unity` / `@uptimizr/godot` /
`@uptimizr/unreal` instead: they bake in the engine's native frame, set the connector provenance
name, and expose the `window.__uptimizr_<engine>__` global the matching copy-in shim expects.

## The two capture tiers

| Tier        | Engine code?        | Captures                                                                     |
| ----------- | ------------------- | ---------------------------------------------------------------------------- |
| **JS-only** | none                | pointer move/click heatmaps, FPS / long frames, JS errors                    |
| **Bridged** | a thin copy-in shim | camera pose → view-direction heatmap, world-space picks, scene proxy, replay |

The JS-only tier is live the moment `trackWebExport` runs. The bridged tier activates when an
engine-side shim starts calling the returned `bridge`.

## Install

```bash
pnpm add @uptimizr/web-export
```

## Canonical usage

```ts
import { trackWebExport } from "@uptimizr/web-export";

const { client, bridge } = trackWebExport({
  projectId: "your-project",
  endpoint: "https://collect.example.com",
  name: "my-engine",
  frame: { handedness: "right", upAxis: "z", unitScale: 100 }, // your engine's NATIVE frame
  canvas: () => document.querySelector("canvas"),
});

// The engine-side shim pushes world-space samples in the engine's native frame:
bridge?.pushPose([0, 1.6, 0], [0, 0, 1], [0, 1, 0], Math.PI / 3);
bridge?.pushPerf(60);

// ... later, on teardown
await client.stop("manual");
```

`bridge` is also published on `window` (default `window.__uptimizr_<name>__`, configurable via
`bridgeGlobal`) so a WASM shim can find it by global name. Start `trackWebExport` **before** the
engine export boots, so the global exists when the shim looks for it.

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

`dispose()` tears the bridge down; `client.stop()` tears down every listener, timer and
animation-frame callback.

## Options

`TrackWebExportOptions`: `projectId`\*, `endpoint`\*, `name`\*, `frame`\*, `version`, `canvas`
(element or resolver), `capture` (`JsOnlyCaptureOptions`), `pointerMoveThrottleMs` (250),
`perfWindowMs` (2000), `jankFrameMs` (50), `sceneId`, `bridgeGlobal` (`false` to publish no
global), `onSceneProxy`, `flushIntervalMs` (5000), `transport`, `disabled`, `debug`, `user`,
`meta`. (\* required.) `bridge` is `undefined` only when the client is `disabled`.

## When to use this package directly

- Your engine is not one we ship a package for (Wonderland, a Bevy/Rust `wasm` build, Stride, any
  in-house Emscripten/WebAssembly renderer drawing to a `<canvas>`) — supply its native `frame`.
- The native frame is configurable or only known at runtime — pass `frame` dynamically.
- You only want the JS-only tier on any canvas app — `trackWebExport`, or `startJsOnlyCapture` for
  the bare primitive.
- You need custom bridge wiring — `createEngineBridge` plus the normalization helpers.
- You are authoring a new `@uptimizr/<engine>` package; `@uptimizr/unity` is the reference.

## Rules for agents

- **All bridge inputs are world-space in the engine's NATIVE frame.** The connector owns the one
  normalization path; an engine-side shim must do **no** coordinate math (ADR 0045 §4/§5).
- **All schema mapping stays in TypeScript.** The engine never emits a schema event directly —
  events live once in `@uptimizr/schema` and are normalized in one place (ADR 0018).
- **Keep the bridge surface tiny and versioned.** `bridge.protocolVersion` exists so a shim can
  assert compatibility against `BRIDGE_PROTOCOL_VERSION` (currently `1`) before pushing. Widening
  the contract means updating every engine shim, so prefer pushing work into the TypeScript side.
- Privacy (ADR 0003): the bridge transmits only low-cardinality, non-PII telemetry — poses, FPS
  and developer-assigned **named** objects. Engine shims MUST NOT invent identifiers or forward
  raw input text. No client-side persistent IDs; the server assigns the cookieless visitor hash.
- **Native (non-web) engine builds are out of scope** (ADR 0045). There is no browser, so none of
  `@uptimizr/sdk-core` can run; do not add a native SDK here.
- `registerRegions(sceneId, regions, { endpoint, apiKey })` (from `@uptimizr/sdk-core`) declares a
  scene's named regions. It **replaces** the scene's set and needs an **`annotate`**-capable key —
  never ship that key in a public bundle; call it from build/deploy/admin code.

## More

- Package reference: [README.md](./README.md)
- Web-export guide: https://uptimizr.com/docs/connectors/web-export/
- Integration guide: https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md

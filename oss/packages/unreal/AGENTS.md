# AGENTS.md — @uptimizr/unreal

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

The **Unreal Engine (web export)** connector for Uptimizr (ADR 0045). Unreal renders into a
`<canvas>` via WebAssembly, so there is no live JS scene to duck-type. This package is a thin
engine-flavoured wrapper over [`@uptimizr/web-export`](../web-export) and works in **two tiers**:

| Tier        | Engine code?                                    | Captures                                                        |
| ----------- | ----------------------------------------------- | --------------------------------------------------------------- |
| **JS-only** | none                                            | pointer move/click heatmaps, FPS / long frames, JS errors       |
| **Bridged** | a thin copy-in shim (see [`bridge/`](./bridge)) | camera pose → view-direction heatmap, world-space picks, replay |

Unreal's native world frame is **left-handed, z-up, centimeters** (`UNREAL_FRAME`,
`unitScale: 100`). It is the only engine that exercises the non-`y` up-axis and non-1 unit-scale
paths: the connector rebases **z-up → y-up** and converts **cm → m** before reaching the canonical
wire frame (ADR 0018 / ADR 0045 §5). The engine-side shim does **no** coordinate math.

**Status — best-effort by design.** Epic deprecated the official HTML5/Emscripten target after
UE 4.24, and Pixel Streaming renders server-side (no client WASM scene to read), so neither fits
this model. The shim targets the real Emscripten-based, client-side web exports — community HTML5
forks (UE 4.24–4.27, WebGL2) and Wonder Interactive / SimplyStream (UE 5.1–5.4, WASM + WebGPU).
Every viable target is experimental or community-maintained, so the **bridged tier is best-effort**;
the JS-only tier always works on any web export that renders into a `<canvas>`.

## Install

```bash
pnpm add @uptimizr/unreal
```

The engine-side bridge is a **copy-in asset**, not an npm dependency — see [`bridge/`](./bridge).

## Canonical usage — the web side

```ts
import { trackUnreal } from "@uptimizr/unreal";

const { client, bridge } = trackUnreal({
  projectId: "your-project",
  endpoint: "https://collect.example.com",
  canvas: () => document.querySelector("#unreal-canvas"),
});

// ... later, on teardown
await client.stop("manual");
```

`trackUnreal` creates the client, registers the JS-only tier collector, publishes the engine
`bridge` (default `window.__uptimizr_unreal__`), and starts the session with Unreal's connector
provenance. Run it **before** the export boots so the bridge global exists when the shim
initializes. `client` is the `@uptimizr/sdk-core` `UptimizrClient` — read `client.sessionId`,
`client.track(name, props)`, `client.setScene(sceneId)`, `client.stop(reason)`.

### Advanced (compose it yourself)

```ts
import { UptimizrClient } from "@uptimizr/sdk-core";
import { unrealCollector, UNREAL_FRAME } from "@uptimizr/unreal";

const client = new UptimizrClient({ projectId: "your-project", endpoint: "..." });
client.use(unrealCollector({ canvas: () => document.querySelector("#unreal-canvas") }));
client.start();
```

Options are `@uptimizr/web-export`'s `TrackWebExportOptions` with `name` and `frame` omitted
(they are fixed to `"unreal"` / `UNREAL_FRAME`): `canvas`, `capture`, `pointerMoveThrottleMs`,
`perfWindowMs`, `jankFrameMs`, `sceneId`, `bridgeGlobal`, `onSceneProxy`, `version`,
`flushIntervalMs`, `transport`, `disabled`, `debug`, `user`, `meta`.

## Canonical usage — the engine side

The bridged tier needs a thin copy-in Emscripten shim: [`bridge/Uptimizr.h`](./bridge/Uptimizr.h)
and [`bridge/Uptimizr.cpp`](./bridge/Uptimizr.cpp).

1. Copy both into your project's `Source/<Module>/` (or a plugin) so they build with your **web**
   target.
2. Load `@uptimizr/unreal` in the export's host page and call `trackUnreal({...})`.
3. Drive the sampler from C++:

   ```cpp
   #include "Uptimizr.h"

   UptimizrTelemetry().Initialize();                   // once, after the page connector is up
   UptimizrTelemetry().Tick(GetWorld(), DeltaSeconds); // every frame
   UptimizrTelemetry().TraceAndReportPick(GetWorld()); // from your click handler
   ```

   …or drive `Init` / `Shutdown` from JS by symbol via `cwrap`
   (`Module.cwrap('UptimizrBridge_Init', 'number', [])`).

`Initialize()` reads the live bridge's `protocolVersion` and asserts it equals
`UPTIMIZR_BRIDGE_PROTOCOL_VERSION` (`1`), staying disabled on a mismatch. `Tick` reads the active
`APlayerCameraManager` pose and accumulates FPS, pushing a pose every frame and a perf sample about
once per second. Outside Emscripten (e.g. the desktop editor) every entry point compiles to a
**no-op**, so the shim is safe to leave wired into every build target.

## Rules for agents

- **Push raw Unreal values — centimeters, z-up, left-handed.** Do **not** pre-convert in the shim;
  the TypeScript connector owns the single normalization path so every engine stays consistent
  (ADR 0045 §4/§5).
- **The shim does no schema mapping.** Events live once in `@uptimizr/schema` and are emitted by
  the connector.
- **Never invent identifiers engine-side** and never forward raw input text (ADR 0003/0045 §6).
  Only poses, FPS and developer-assigned **named** objects cross the bridge (a pick sends the
  actor's `GetName()` and the world hit point). No client-side persistent IDs; the server assigns
  the cookieless visitor hash.
- `UNREAL_FRAME` is `{ handedness: "left", upAxis: "z", unitScale: 100 }` — it is the regression
  canary for the non-y / non-1 normalization paths. Changing it silently corrupts every
  world-space aggregate.
- Capture channels that need the engine (camera pose, world-space picks, scene proxy, replay) are
  simply **absent** without the shim — do not fake them from the DOM.
- `registerRegions(sceneId, regions, { endpoint, apiKey })` (from `@uptimizr/sdk-core`) declares a
  scene's named regions. It **replaces** the scene's set and needs an **`annotate`**-capable key —
  never ship that key in a public bundle; call it from build/deploy/admin code.
- Native (non-web) Unreal builds and **Pixel Streaming** are out of scope (ADR 0045): server-side
  rendering has no client WASM scene to read.

## Export / build caveats

- You need an **Emscripten-based, client-side** web target (a community HTML5 fork, or Wonder
  Interactive / SimplyStream). There is no official Epic web target to build against.
- The shim compiles to no-ops off Emscripten, so it can stay in the module for every target.
- Point `canvas` at the export's real canvas element and start `trackUnreal` before the export
  boots.

## More

- Package reference: [README.md](./README.md)
- Engine-side bridge: [`bridge/README.md`](./bridge/README.md)
- Unreal guide: https://uptimizr.com/docs/connectors/unreal/
- Shared foundation: [`@uptimizr/web-export`](../web-export/AGENTS.md)
- Integration guide: https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md

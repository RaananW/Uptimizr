# @uptimizr/godot

The **Godot (Web export)** connector for Uptimizr (ADR 0045). Godot 4 compiles to
WebAssembly and renders into a `<canvas>`, so there is no live JS scene to read — this
connector is built on [`@uptimizr/web-export`](../web-export) and works in **two
tiers**:

| Tier        | Engine code?                                    | Captures                                                        |
| ----------- | ----------------------------------------------- | --------------------------------------------------------------- |
| **JS-only** | none                                            | pointer move/click heatmaps, FPS / long frames, JS errors       |
| **Bridged** | a thin copy-in shim (see [`bridge/`](./bridge)) | camera pose → view-direction heatmap, world-space picks, replay |

Godot's native world frame is **right-handed, y-up, meters**, so the connector negates
Z to reach the canonical wire frame (left-handed, y-up — ADR 0018). The engine-side
shim does **no** coordinate math.

### Verification status

| Tier        | Status       | How it is verified                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **JS-only** | **Stable**   | Unit tests plus the web-export Playwright round trip (`examples/playground/e2e/web-export.spec.ts`).                                                                                                                                                                                                                                                                                                                |
| **Bridged** | **Verified** | An **automated headless Godot 4.7.2 Web export** of the reference sample project, driven by Playwright in CI (`godot-export-e2e` job → `examples/playground/e2e/godot-export.spec.ts`). It boots the real WASM export with the shipped `UptimizrGodot.gd` autoload and asserts `camera_sample` (Z negated), `mesh_interaction` (raycast pick named `Crate`), `frame_perf`, and the scene proxy reach the collector. |

The **reference integration** is
[`examples/godot-web-export`](../../../examples/godot-web-export/README.md) — a minimal
Godot 4 project with the autoload registered, named pickable `StaticBody3D` props, and a
nothreads Web preset (`pnpm godot:fetch && pnpm godot:export && pnpm test:e2e:godot`
reproduces the CI proof locally). The sample's copy of the shim is checked byte-for-byte
against `bridge/UptimizrGodot.gd`, so the test always exercises the asset you ship.

## Install

```bash
npm install @uptimizr/godot
```

The engine-side bridge is a **copy-in asset** (a `JavaScriptBridge` autoload), not an
npm dependency — see [`bridge/`](./bridge).

## Usage

```ts
import { trackGodot } from "@uptimizr/godot";

const { client, bridge } = trackGodot({
  projectId: "your-project",
  endpoint: "https://collect.example.com",
  canvas: () => document.querySelector("#godot-canvas"),
});

// ... later, on teardown
await client.stop("manual");
```

`trackGodot` creates the client, registers the JS-only tier collector, exposes the
engine `bridge` (default `window.__uptimizr_godot__`), and starts the session with
Godot's connector provenance. The JS-only tier captures immediately; wire the
engine-side shim to `bridge` to add camera pose, picks, and replay.

### Advanced: wire it up yourself

```ts
import { UptimizrClient } from "@uptimizr/sdk-core";
import { godotCollector, GODOT_FRAME } from "@uptimizr/godot";

const client = new UptimizrClient({ projectId: "your-project", endpoint: "..." });
client.use(godotCollector({ canvas: () => document.querySelector("#godot-canvas") }));
client.start();
```

## Engine-side bridge

The bridged tier needs a thin copy-in shim that pushes world-space pose / picks / FPS
across Godot's `JavaScriptBridge`. The package ships ready-to-use autoloads in both
languages — [`bridge/UptimizrGodot.gd`](./bridge/UptimizrGodot.gd) (GDScript) and
[`bridge/UptimizrGodot.cs`](./bridge/UptimizrGodot.cs) (C#). Copy one into your Godot 4
project and register it as an Autoload named `UptimizrGodot` (**Project → Project Settings →
Globals → Autoload**). It guards on `OS.has_feature("web")`, so it is a no-op outside the
Web export. Full setup, options, and the bridge contract are in
[`bridge/README.md`](./bridge/README.md).

## Privacy

No client-side persistent IDs and no PII by default (ADR 0003). `client.stop()` tears
down every listener, timer, and animation-frame callback.

## License

Apache-2.0.

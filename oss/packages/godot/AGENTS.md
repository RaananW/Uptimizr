# AGENTS.md — @uptimizr/godot

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

The **Godot 4 (Web export)** connector for Uptimizr (ADR 0045). Godot compiles to WebAssembly and
renders into a `<canvas>`, so there is no live JS scene to duck-type. This package is a thin
engine-flavoured wrapper over [`@uptimizr/web-export`](../web-export) and works in **two tiers**:

| Tier        | Engine code?                                    | Captures                                                        |
| ----------- | ----------------------------------------------- | --------------------------------------------------------------- |
| **JS-only** | none                                            | pointer move/click heatmaps, FPS / long frames, JS errors       |
| **Bridged** | a thin copy-in shim (see [`bridge/`](./bridge)) | camera pose → view-direction heatmap, world-space picks, replay |

Godot's native world frame is **right-handed, y-up, meters** (`GODOT_FRAME`), so the connector
negates Z to reach the canonical wire frame (left-handed, y-up — ADR 0018). The engine-side shim
does **no** coordinate math.

**Status.** Both tiers are verified. The JS-only tier has unit tests plus the web-export Playwright
round trip; the bridged tier is proven in CI by an **automated headless Godot Web export** of the
reference sample project (`godot-export-e2e` → `examples/playground/e2e/godot-export.spec.ts`),
which boots the real WASM export with the shipped `UptimizrGodot.gd` autoload and asserts
`camera_sample` (Z negated), `mesh_interaction`, `frame_perf` and the scene proxy reach the
collector.

## Install

```bash
pnpm add @uptimizr/godot
```

The engine-side bridge is a **copy-in asset**, not an npm dependency — see [`bridge/`](./bridge).

## Canonical usage — the web side

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

`trackGodot` creates the client, registers the JS-only tier collector, publishes the engine
`bridge` (default `window.__uptimizr_godot__`), and starts the session with Godot's connector
provenance. Run it **before** the export boots so the bridge global exists when the autoload looks
for it. `client` is the `@uptimizr/sdk-core` `UptimizrClient` — read `client.sessionId`,
`client.track(name, props)`, `client.setScene(sceneId)`, `client.stop(reason)`.

### Advanced (compose it yourself)

```ts
import { UptimizrClient } from "@uptimizr/sdk-core";
import { godotCollector, GODOT_FRAME } from "@uptimizr/godot";

const client = new UptimizrClient({ projectId: "your-project", endpoint: "..." });
client.use(godotCollector({ canvas: () => document.querySelector("#godot-canvas") }));
client.start();
```

Options are `@uptimizr/web-export`'s `TrackWebExportOptions` with `name` and `frame` omitted
(they are fixed to `"godot"` / `GODOT_FRAME`): `canvas`, `capture`, `pointerMoveThrottleMs`,
`perfWindowMs`, `jankFrameMs`, `sceneId`, `bridgeGlobal`, `onSceneProxy`, `version`,
`flushIntervalMs`, `transport`, `disabled`, `debug`, `user`, `meta`.

## Canonical usage — the engine side

The bridged tier needs a thin copy-in autoload that pushes world-space pose / picks / FPS across
Godot's `JavaScriptBridge`. Ready-to-use autoloads ship in both languages:

- [`bridge/UptimizrGodot.gd`](./bridge/UptimizrGodot.gd) (GDScript)
- [`bridge/UptimizrGodot.cs`](./bridge/UptimizrGodot.cs) (C#)

Copy one into your Godot 4 project and register it as an Autoload named `UptimizrGodot`
(**Project → Project Settings → Globals → Autoload**). It guards on `OS.has_feature("web")`, so it
is a no-op outside the Web export. Full setup, options and the bridge contract are in
[`bridge/README.md`](./bridge/README.md).

## Rules for agents

- **The shim does no coordinate math and no schema mapping.** It pushes Godot's native-frame
  world-space values; the TypeScript connector negates Z and emits `@uptimizr/schema` events.
  Events live once (ADR 0045 §1/§4).
- **Never invent identifiers engine-side** and never forward raw input text (ADR 0003/0045 §6).
  Only poses, FPS and developer-assigned **named** objects cross the bridge. No client-side
  persistent IDs; the server assigns the cookieless visitor hash.
- `examples/godot-web-export/` carries a copy of `UptimizrGodot.gd` that is checked **byte for
  byte** against `bridge/UptimizrGodot.gd` (`pnpm godot:check-bridge`), so the CI export test
  always exercises the asset you ship. Change the shipped asset, then re-sync the sample.
- Keep the two language shims behaviourally identical — a fix in the GDScript autoload belongs in
  the C# one too.
- `GODOT_FRAME` is right-handed: the Z negation lives in the TypeScript normalizers. Changing it
  silently corrupts every world-space aggregate.
- Capture channels that need the engine (camera pose, world-space picks, scene proxy, replay) are
  simply **absent** without the autoload — do not fake them from the DOM.
- `registerRegions(sceneId, regions, { endpoint, apiKey })` (from `@uptimizr/sdk-core`) declares a
  scene's named regions. It **replaces** the scene's set and needs an **`annotate`**-capable key —
  never ship that key in a public bundle; call it from build/deploy/admin code.
- Native (non-web) Godot builds are **out of scope** (ADR 0045): there is no browser, so none of
  `@uptimizr/sdk-core` can run.

## Export / build caveats

- Use a **nothreads** Web preset (the reference sample does); `JavaScriptBridge` is only available
  in a Web export, and the autoload no-ops elsewhere.
- Click picks push the **first named collider** the physics ray hits, so give pickable bodies
  meaningful node names — the node `name` is what reaches the analytics.
- The scene proxy is **developer opt-in**: add each `VisualInstance3D` you want described to the
  `uptimizr_tracked` group, then call `UptimizrGodot.push_scene_proxy()` once the scene is built.
- Autoload knobs: `pose_samples_per_second` (30; `<= 0` pushes every frame), `capture_picks`
  (true), `pick_ray_length` (1000 m).
- Reproduce the CI proof locally with `pnpm godot:fetch && pnpm godot:export && pnpm test:e2e:godot`.

## More

- Package reference: [README.md](./README.md)
- Engine-side bridge: [`bridge/README.md`](./bridge/README.md)
- Godot guide: https://uptimizr.com/docs/connectors/godot/
- Shared foundation: [`@uptimizr/web-export`](../web-export/AGENTS.md)
- Integration guide: https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md

# AGENTS.md — @uptimizr/unity

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

The **Unity (WebGL export)** connector for Uptimizr (ADR 0045). Unity compiles to WebAssembly and
renders into a `<canvas>`, so there is no live JS scene to duck-type. This package is a thin
engine-flavoured wrapper over [`@uptimizr/web-export`](../web-export) and works in **two tiers**:

| Tier        | Engine code?                                    | Captures                                                        |
| ----------- | ----------------------------------------------- | --------------------------------------------------------------- |
| **JS-only** | none                                            | pointer move/click heatmaps, FPS / long frames, JS errors       |
| **Bridged** | a thin copy-in shim (see [`bridge/`](./bridge)) | camera pose → view-direction heatmap, world-space picks, replay |

Unity's native world frame is **left-handed, y-up, meters** (`UNITY_FRAME`) — already Uptimizr's
canonical wire frame (ADR 0018), so world-space payloads need **no axis conversion**; the
normalization is the identity for Unity.

**Status.** The JS-only tier is covered end to end by the playground's Playwright suite. The
bridged tier is **preview**: the `.jslib` shim is sanity-tested under `node:vm` on every
`pnpm test`, and the full round trip through a real Unity WebGL export is driven by a Playwright
spec against a **local build** of `examples/unity-web-export/` (it skips in CI without a build).

## Install

```bash
pnpm add @uptimizr/unity
```

The engine-side bridge is a **copy-in asset**, not an npm dependency — see [`bridge/`](./bridge).

## Canonical usage — the web side

```ts
import { trackUnity } from "@uptimizr/unity";

const { client, bridge } = trackUnity({
  projectId: "your-project",
  endpoint: "https://collect.example.com",
  canvas: () => document.querySelector("#unity-canvas"),
});

// ... later, on teardown
await client.stop("manual");
```

`trackUnity` creates the client, registers the JS-only tier collector, publishes the engine
`bridge` (default `window.__uptimizr_unity__`), and starts the session with Unity's connector
provenance. Run it **before** `createUnityInstance` so the bridge global exists when the shim
looks for it. `client` is the `@uptimizr/sdk-core` `UptimizrClient` — read `client.sessionId`,
`client.track(name, props)`, `client.setScene(sceneId)`, `client.stop(reason)`.

### Advanced (compose it yourself)

```ts
import { UptimizrClient } from "@uptimizr/sdk-core";
import { unityCollector, UNITY_FRAME } from "@uptimizr/unity";

const client = new UptimizrClient({ projectId: "your-project", endpoint: "..." });
client.use(unityCollector({ canvas: () => document.querySelector("#unity-canvas") }));
client.start();
```

Options are `@uptimizr/web-export`'s `TrackWebExportOptions` with `name` and `frame` omitted
(they are fixed to `"unity"` / `UNITY_FRAME`): `canvas`, `capture`, `pointerMoveThrottleMs`,
`perfWindowMs`, `jankFrameMs`, `sceneId`, `bridgeGlobal`, `onSceneProxy`, `version`,
`flushIntervalMs`, `transport`, `disabled`, `debug`, `user`, `meta`.

## Canonical usage — the engine side

The bridged tier needs a thin copy-in shim that pushes world-space pose / picks / FPS across
Unity's JS interop boundary. Two files ship in [`bridge/`](./bridge):

- **`Uptimizr.jslib`** → copy to `Assets/Plugins/WebGL/Uptimizr.jslib`.
- **`UptimizrUnityBridge.cs`** → copy under `Assets/` and add the `UptimizrUnityBridge` component
  to a GameObject. It samples the active `Camera`, raycast picks and FPS, and calls the `.jslib`
  exports via `[DllImport("__Internal")]`.

The shim asserts on start that `bridge.protocolVersion` matches `BRIDGE_PROTOCOL_VERSION` (`1`).
See [`bridge/README.md`](./bridge/README.md) for the full contract and the JS API table.

## Rules for agents

- **The shim does no coordinate math and no schema mapping.** It pushes Unity's native-frame
  world-space values; the TypeScript connector normalizes and emits `@uptimizr/schema` events.
  Events live once (ADR 0045 §1/§4).
- **Never invent identifiers engine-side** and never forward raw input text (ADR 0003/0045 §6).
  Only poses, FPS and developer-assigned **named** objects cross the bridge. No client-side
  persistent IDs; the server assigns the cookieless visitor hash.
- The `.jslib` exports and the `[DllImport]`s in `UptimizrUnityBridge.cs` must stay in sync, and
  every export must declare its `__deps` (a missing dep is a silent link-time drop) —
  `src/__tests__/jslib.test.ts` fails otherwise.
- `examples/unity-web-export/` carries copies of both bridge files; a lint script fails if they
  drift from `bridge/`. Change the shipped asset, then re-sync the sample — never only the sample.
- Unity's frame is already canonical: do **not** add an axis conversion. Changing `UNITY_FRAME`
  silently corrupts every world-space aggregate.
- Capture channels that need the engine (camera pose, world-space picks, scene proxy, replay) are
  simply **absent** without the shim — do not fake them from the DOM.
- `registerRegions(sceneId, regions, { endpoint, apiKey })` (from `@uptimizr/sdk-core`) declares a
  scene's named regions. It **replaces** the scene's set and needs an **`annotate`**-capable key —
  never ship that key in a public bundle; call it from build/deploy/admin code.
- Native (non-web) Unity builds are **out of scope** (ADR 0045): there is no browser, so none of
  `@uptimizr/sdk-core` can run.

## Export / build caveats

- Build the sample with **Compression Format: Disabled** for local Playwright verification
  (a gzip/brotli export needs matching server headers).
- Start `trackUnity(...)` before `createUnityInstance`, and point `canvas` at the export's real
  canvas element (Unity creates `#unity-canvas` by default).

## More

- Package reference: [README.md](./README.md)
- Engine-side bridge: [`bridge/README.md`](./bridge/README.md)
- Unity guide: https://uptimizr.com/docs/connectors/unity/
- Shared foundation: [`@uptimizr/web-export`](../web-export/AGENTS.md)
- Integration guide: https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md

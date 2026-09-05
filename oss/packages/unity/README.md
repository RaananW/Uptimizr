# @uptimizr/unity

The **Unity (WebGL export)** connector for Uptimizr (ADR 0045). Unity compiles to
WebAssembly and renders into a `<canvas>`, so there is no live JS scene to read — this
connector is built on [`@uptimizr/web-export`](../web-export) and works in **two
tiers**:

| Tier        | Engine code?                                    | Captures                                                        |
| ----------- | ----------------------------------------------- | --------------------------------------------------------------- |
| **JS-only** | none                                            | pointer move/click heatmaps, FPS / long frames, JS errors       |
| **Bridged** | a thin copy-in shim (see [`bridge/`](./bridge)) | camera pose → view-direction heatmap, world-space picks, replay |

Unity's native world frame is **left-handed, y-up, meters** — already Uptimizr's
canonical wire frame (ADR 0018), so world-space payloads need **no axis conversion**.

> **Status.** The JS-only tier is covered end to end by the playground's Playwright
> suite. The bridged tier is **preview**: the `.jslib` shim is sanity-tested under
> `node:vm` on every `pnpm test`, and the full round trip through a real Unity WebGL
> export is driven by a Playwright spec against a **local build** of the sample project
> in [`examples/unity-web-export/`](../../../examples/unity-web-export) — it is labelled
> **verified against a local build** once a maintainer has run that spec. See
> [Verifying against a real export](#verifying-against-a-real-export).

## Install

```bash
npm install @uptimizr/unity
```

The engine-side bridge is a **copy-in asset** (a `.jslib` plugin + a small
`MonoBehaviour`), not an npm dependency — see [`bridge/`](./bridge).

## Usage

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

`trackUnity` creates the client, registers the JS-only tier collector, exposes the
engine `bridge` (default `window.__uptimizr_unity__`), and starts the session with
Unity's connector provenance. The JS-only tier captures immediately; wire the
engine-side shim to `bridge` to add camera pose, picks, and replay.

### Advanced: wire it up yourself

```ts
import { UptimizrClient } from "@uptimizr/sdk-core";
import { unityCollector, UNITY_FRAME } from "@uptimizr/unity";

const client = new UptimizrClient({ projectId: "your-project", endpoint: "..." });
client.use(unityCollector({ canvas: () => document.querySelector("#unity-canvas") }));
client.start();
```

## Engine-side bridge

The bridged tier needs a thin copy-in shim that pushes world-space pose / picks / FPS
across Unity's JS interop boundary. It ships in [`bridge/`](./bridge) as two copy-in
files:

- **`Uptimizr.jslib`** → copy to `Assets/Plugins/WebGL/Uptimizr.jslib`.
- **`UptimizrUnityBridge.cs`** → copy under `Assets/` and add the `UptimizrUnityBridge`
  component to a GameObject (it samples the active `Camera`, raycast picks, and FPS).

Make sure `trackUnity(...)` runs on the host page before the export starts, so the bridge
global (`window.__uptimizr_unity__`) exists. The shim does **no** coordinate math — it
pushes Unity's native-frame values and the connector normalizes them. On start it asserts
the bridge protocol version matches `BRIDGE_PROTOCOL_VERSION` (1). See
[`bridge/README.md`](./bridge/README.md) for the full contract and the JS API table.

## Verifying against a real export

Unity is not part of the JS toolchain, so verification is split in two:

- **Always on (CI):** `src/__tests__/jslib.test.ts` loads `bridge/Uptimizr.jslib` as
  text, evaluates it in a `node:vm` sandbox with mocked Emscripten globals
  (`mergeInto`, `LibraryManager.library`, `UTF8ToString`, `window`), resolves the
  `$UptimizrUnityBridge` dependency the way Emscripten does, and asserts every export
  forwards to `window.__uptimizr_unity__` — plus that each export declares its `__deps`
  (a missing dep is a silent link-time drop) and that the export set matches the
  `[DllImport]`s in `UptimizrUnityBridge.cs`.
- **One manual step (maintainer):** the sample Unity 2022.3 LTS project in
  [`examples/unity-web-export/`](../../../examples/unity-web-export) carries copies of
  both bridge files (a lint script fails if they drift), a camera, and three named
  cubes with colliders. Open it in Unity Hub and **File → Build Settings → WebGL →
  Build** into `examples/unity-web-export/dist/` with **Compression Format: Disabled**.
  Then `examples/playground/e2e/unity-export.spec.ts` serves the build, starts
  `trackUnity` **before** `createUnityInstance`, clicks the centre cube, and asserts
  `session_start.connector.name === "unity"`, `camera_sample`, `mesh_interaction`, and
  `frame_perf` reach the collector. Without a build the spec skips (the default in CI).

## Privacy

No client-side persistent IDs and no PII by default (ADR 0003). `client.stop()` tears
down every listener, timer, and animation-frame callback.

## License

Apache-2.0.

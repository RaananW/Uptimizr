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
across Unity's JS interop boundary. The contract and a `.jslib` sketch live in
[`bridge/README.md`](./bridge/README.md). The full shim is authored in the Unity
web-export sub-issue (umbrella #111).

## Privacy

No client-side persistent IDs and no PII by default (ADR 0003). `client.stop()` tears
down every listener, timer, and animation-frame callback.

## License

Apache-2.0.

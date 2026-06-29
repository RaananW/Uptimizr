# @uptimizr/unreal

The **Unreal Engine (web export)** connector for Uptimizr (ADR 0045). Unreal renders
into a `<canvas>` via WebAssembly, so there is no live JS scene to read — this
connector is built on [`@uptimizr/web-export`](../web-export) and works in **two
tiers**:

| Tier        | Engine code?                                    | Captures                                                        |
| ----------- | ----------------------------------------------- | --------------------------------------------------------------- |
| **JS-only** | none                                            | pointer move/click heatmaps, FPS / long frames, JS errors       |
| **Bridged** | a thin copy-in shim (see [`bridge/`](./bridge)) | camera pose → view-direction heatmap, world-space picks, replay |

> **Best-effort.** Unreal's first-party web export is community-maintained, so the
> bridged tier is best-effort by design (ADR 0045). The JS-only tier always works.

Unreal's native world frame is **left-handed, z-up, centimeters**, so the connector
rebases **z-up → y-up**, converts **cm → m**, and reaches the canonical wire frame
(left-handed, y-up, unit scale 1 — ADR 0018). The engine-side shim does **no**
coordinate math — it pushes raw Unreal values.

## Install

```bash
npm install @uptimizr/unreal
```

The engine-side bridge is a **copy-in asset** (Emscripten `EM_JS` glue), not an npm
dependency — see [`bridge/`](./bridge).

## Usage

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

`trackUnreal` creates the client, registers the JS-only tier collector, exposes the
engine `bridge` (default `window.__uptimizr_unreal__`), and starts the session with
Unreal's connector provenance. The JS-only tier captures immediately; wire the
engine-side shim to `bridge` to add camera pose, picks, and replay.

### Advanced: wire it up yourself

```ts
import { UptimizrClient } from "@uptimizr/sdk-core";
import { unrealCollector, UNREAL_FRAME } from "@uptimizr/unreal";

const client = new UptimizrClient({ projectId: "your-project", endpoint: "..." });
client.use(unrealCollector({ canvas: () => document.querySelector("#unreal-canvas") }));
client.start();
```

## Engine-side bridge

The bridged tier needs a thin copy-in shim that pushes world-space pose / picks / FPS
across Unreal's Emscripten glue. The contract and an `EM_JS` sketch live in
[`bridge/README.md`](./bridge/README.md). The full shim is authored in the Unreal
web-export sub-issue (umbrella #111).

## Privacy

No client-side persistent IDs and no PII by default (ADR 0003). `client.stop()` tears
down every listener, timer, and animation-frame callback.

## License

Apache-2.0.

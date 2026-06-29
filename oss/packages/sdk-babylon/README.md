# @uptimizr/babylon

The Babylon.js connector for Uptimizr. It registers as an
[`@uptimizr/sdk-core`](../sdk-core) **collector** and captures:

- **camera pose** (position + forward direction) → view-direction heatmap
- **pointer move / click** (normalized screen + optional raycast hit) → screen heatmaps
- **mesh picks** → object-engagement analytics
- **FPS** → performance

`@babylonjs/core` is a **peer dependency**: the connector reads from the host
application's Babylon instance and never bundles or mutates the scene. It tears down
all observers and timers on stop.

## Install

```bash
npm install @uptimizr/babylon @babylonjs/core
```

`@babylonjs/core` is a **peer dependency** — the connector reads your existing
Babylon instance and never bundles its own.

## Usage

The quickest integration is a single call:

```ts
import { trackScene } from "@uptimizr/babylon";

const client = trackScene(scene, {
  projectId: "your-project",
  endpoint: "https://collect.example.com",
});

// ... later, on teardown
await client.stop("manual");
```

`trackScene` creates the client, registers the collector, reads device/GPU caps,
and starts the session. It returns the [`@uptimizr/sdk-core`](../sdk-core)
`UptimizrClient`, so you can read `client.sessionId`, emit custom events, or stop it.

### Advanced: wire it up yourself

For a custom transport, a `beforeSend` hook, or registering multiple collectors,
compose the pieces directly:

```ts
import { UptimizrClient } from "@uptimizr/sdk-core";
import { babylonCollector, readDeviceCaps } from "@uptimizr/babylon";

const client = new UptimizrClient({
  projectId: "your-project",
  endpoint: "https://collect.example.com",
});

client.use(babylonCollector({ scene }));

// device/GPU caps ride along on session_start
client.start({ device: readDeviceCaps(scene) });

// ... later, on teardown
client.stop("manual");
```

### Options

Both `trackScene` and `babylonCollector` accept the same sampling/capture knobs:

```ts
babylonCollector({
  scene,
  sampleCameraMs: 1000, // camera-pose sampling interval
  samplePerfMs: 2000, // FPS sampling interval
  pointerMoveThrottleMs: 250, // min gap between pointer_move samples
  capture: { camera: true, pointerMove: true, clicks: true, meshPicks: true, perf: true },
});
```

### Capture fidelity

The `sampling` profile sets the per-channel fidelity dial in **Hz** (`0` = off,
`"frame"` = every render tick). It governs continuous channels only — camera pose,
pointer move, and perf; discrete events (clicks, picks, scene changes, custom) are
always captured. An explicit channel overrides the matching `*Ms` knob above; there
is no enforced ceiling, so higher fidelity costs storage/ingest.

```ts
babylonCollector({
  scene,
  sampling: { camera: 10, pointerMove: 60, perf: 0.5 }, // 10 Hz pose, 60 Hz pointer
});
```

### Input source

Pointer and mesh events carry the originating input `source` — `mouse`, `touch`,
or `pen` — derived from the browser `pointerType` Babylon forwards. No extra wiring
is needed; a finger tap and a stylus click are distinguishable downstream (the
pointer/world heatmap query endpoints accept a `source` filter). Unknown pointer
types map to `other`, and the field is omitted when the source is unknown.

### Pointer lock (ADR 0034)

When the rendering canvas holds the browser pointer lock (`engine.enterPointerlock()`,
first-person/FPS navigation), the OS cursor is hidden and `scene.pointerX/Y` freeze
at the lock point. The connector detects this and reports `pointer_move` /
`pointer_down` / `pointer_up` / `pointer_click` from the viewport centre
(`screen = [0.5, 0.5]`), re-picking at the render-target centre (`scene.pick(width/2,
height/2)`) — the crosshair the visitor actually aims with. The 2D pointer heatmap
therefore clusters at the centre for locked scenes; read the cursor-independent
gaze/floor-plan heatmaps and trajectories instead. Cursor (orbit/viewer) scenes are
unaffected.

### Capability changes (`capability_change`, #49)

Backend fallbacks and fidelity changes — a WebGPU→WebGL2 downgrade, a quality/LOD
auto-downgrade, or a re-init after a lost device — are **app/engine decisions with
no reliable runtime hook**, so the connector does **not** auto-capture them. Report
them from your app with the engine-neutral
`client.reportCapabilityChange({ kind, from?, to?, reason? })` (sdk-core); `kind`
is one of `graphics-backend` / `quality` / `device-recovery` / `feature` / `other`.
The raw GPU lifecycle (`context_lost` / `context_restored`) is still captured by the
connector — `capability_change` is the higher-level companion that explains
perf/visual-fidelity variance across the user base.

```ts
// e.g. after Babylon's WebGPU engine init throws and you fall back:
client.reportCapabilityChange({ kind: "graphics-backend", from: "webgpu", to: "webgl2" });
```

### Engine diagnostics: WebGPU `device.lost` (`graphics_diagnostic`, #20)

When the client is created with `captureGraphicsDiagnostics: true` (off by default),
the connector subscribes to the WebGPU `GPUDevice.lost` promise and emits one
`graphics_diagnostic` with `category: "device-lost"` and `backend: "webgpu"`. Severity is
`info` for a requested loss (`reason: "destroyed"`) and `fatal` for an unrequested one;
the optional `message` is length-capped and passes through `beforeSend` for redaction.

This is opt-in (the text can carry driver detail) and engine-parity with the three
connector. **WebGL is a no-op** — it has no device-lost concept, and its interruption is
the always-on `context_lost` event above.

```ts
const client = new UptimizrClient({ projectId, endpoint, captureGraphicsDiagnostics: true });
```

length-capped and runs through `beforeSend`. **WebGL is a no-op.**

### Engine diagnostics: context-creation failure (`graphics_diagnostic`, #18)

Also gated by `captureGraphicsDiagnostics`, the connector checks at init whether the
Babylon engine obtained a usable backend. If no WebGL context could be created, it emits
**one** `graphics_diagnostic` with `category: "context-loss"`, `severity: "fatal"`, and
`backend: "unknown"` (a failed context exposes nothing to introspect). It fires before the
first flush, but is queued in order after `session_start` so it always lands.

## Standalone bundle (drop into the Babylon Playground)

Because every `@babylonjs/core` import in this package is a **type-only** import,
the compiled connector has **zero runtime dependency on Babylon** — it reads the
scene by duck typing. That makes it safe to async-load into a page that already
has its own Babylon instance, such as the official
[Babylon.js Playground](https://playground.babylonjs.com).

`pnpm --filter @uptimizr/babylon build` emits a single self-contained ESM file at
`dist/uptimizr-babylon.js` (sdk-core, schema, and Zod inlined; `@babylonjs/core`
left external but never referenced at runtime). Host it anywhere that serves it
over **HTTPS** with permissive CORS (`Access-Control-Allow-Origin: *`), then:

```js
// In a Babylon Playground, after you have a `scene`:
const { trackScene } = await import("https://your-host.example.com/uptimizr-babylon.js");

trackScene(scene, {
  projectId: "your-project",
  endpoint: "https://collect.example.com", // must also be HTTPS (no mixed content)
  sampling: { camera: 10, pointerMove: 60 },
});
```

Two requirements for the round trip to work from a third-party origin:

- The collector must allow the page's origin via `COLLECTOR_CORS_ORIGINS` (e.g.
  add `https://playground.babylonjs.com`).
- Both the bundle URL and the collector endpoint must be **HTTPS** — a
  `http://localhost` endpoint is blocked as mixed content. Use a tunnel
  (cloudflared/ngrok) or a deployed collector.

## Adding another engine

This package is the reference connector. To support another 3D engine, create a sibling
package (e.g. `@uptimizr/three`) that depends only on `@uptimizr/sdk-core` and
`@uptimizr/schema`, and export a `Collector` the same way. See `.github/skills/add-connector`.

## Develop

```bash
pnpm --filter @uptimizr/babylon build
pnpm --filter @uptimizr/babylon typecheck
pnpm --filter @uptimizr/babylon test
```

## License

[Apache-2.0](./LICENSE) © Uptimizr.

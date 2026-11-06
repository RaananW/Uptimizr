---
title: Configuration reference
description: Every SDK option and where it goes (trackScene, the connector collector, or UptimizrClient) — camera, sampling, idle suppression, channel toggles, delivery, privacy.
lastUpdated: 2026-11-06
---

SDK options live on three layers. `trackScene(scene, options)` is the one-call path: it forwards a
fixed set of options to the connector's collector and to the client, and ignores anything else. The
same names apply across connectors (the engine-specific arguments — `camera`, `renderer`,
`canvas` — differ; see each [connector page](/docs/connectors/overview/)).

| Accepted by                    | Options                                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `trackScene` and the collector | `sampling`, the legacy ms knobs, idle suppression, `capture`, `gaze`, `actors`, `keyBindings`; on Babylon also `camera`, `jankFrameMs`, `meshVisibility`                                         |
| `trackScene` only              | `projectId`, `endpoint`, `flushIntervalMs`, `transport`, `disabled`, `debug`, `meta`, `sceneDescription`, `user`, `xr`                                                                           |
| The collector only             | `hoverDwell`, `resourceSample`, `cameraGestureSensitivity`, `raycast`; on three, PlayCanvas and Babylon Lite also `meshVisibility`                                                               |
| `new UptimizrClient()` only    | `batchSize`, `maxQueueSize`, `offload`, `createWorker`, `beforeSend`, `sdkVersion`, `captureLifecycle`, `resizeDebounceMs`, `captureErrors`, `captureGraphicsDiagnostics`, `captureShaderSource` |

The collector is `babylonCollector`, `threeCollector`, `playcanvasCollector` or `liteCollector`. To
set a collector-only or client-only option, compose the two yourself — see
[custom client](#advanced-custom-client--beforesend).

```ts
trackScene(scene, {
  projectId: "your-project-id",
  endpoint: "https://collect.example.com",
  // ...everything below is optional
});
```

## Identity & context

| Option             | Type   | Default | Effect                                                                                                                                                         |
| ------------------ | ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectId`        | string | —       | **Required.** Your project id (routes data to the right project).                                                                                              |
| `endpoint`         | string | —       | **Required.** Base URL of your collector.                                                                                                                      |
| `meta`             | object | —       | Extra `session_start` context: `sceneId` (1–64 chars of `[A-Za-z0-9._:-]`; anything else is ignored), `url`, `pageMeta`.                                       |
| `sceneDescription` | string | —       | Free-text description of the scene, surfaced on the session.                                                                                                   |
| `user`             | object | —       | **Opt-in**, anonymized user descriptor (`user.id` pseudonymous/hashed; `user.traits` non-identifying). See [sessions](/docs/guides/sessions/#anonymized-user). |

## Camera

| Option   | Default       | Effect                                                                                                                                                                                 |
| -------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `camera` | active camera | Which camera the pose/view-direction timeline records. **Set explicitly for multi-camera scenes** (insets, split-screen, render targets) — otherwise the "active" camera is ambiguous. |

## Capture fidelity (`sampling`) — preferred

A per-channel rate dial for the **continuous** channels. Each rate is a positive **number**
(Hz), `"frame"` (every render tick), or `0` (off).

```ts
sampling: {
  camera: 10,        // 10 Hz camera pose
  pointerMove: 60,   // 60 Hz pointer movement
  perf: 0.5,         // a perf sample every 2 s
  // nodes / bones — scene actors, see Mesh & object tracking
}
```

Omitted channels keep conservative defaults (≈1 Hz camera, ≈4 Hz pointer, ≈0.5 Hz perf). There is no
enforced ceiling — higher fidelity just costs more storage. **Discrete** events (clicks, button
up/down, mesh interactions, scene changes, session start/end, custom, input actions, and the lifecycle
events) are always captured at 100% and cannot be rate-limited.

`sampling.perSource` is reserved: the type accepts it, but no connector applies it yet. XR pose
cadence is set with `xr.sampleMs`.

### Legacy millisecond knobs

A matching `sampling` channel overrides these:

| Option                  | Default | Effect                                      |
| ----------------------- | ------- | ------------------------------------------- |
| `sampleCameraMs`        | `1000`  | Camera-pose sampling interval.              |
| `samplePerfMs`          | `2000`  | Perf (FPS) sampling interval.               |
| `pointerMoveThrottleMs` | `250`   | Minimum gap between `pointer_move` samples. |

## Idle suppression & dedupe

| Option                    | Default | Effect                                                                                     |
| ------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `suppressIdleSamples`     | `true`  | Skip timer-based **camera** samples while the pose is unchanged (first is always emitted). |
| `cameraEpsilon`           | `1e-3`  | Max per-axis pose change treated as "unchanged".                                           |
| `suppressIdlePerfSamples` | `false` | Dedupe `frame_perf` while FPS is steady. Off because a stable FPS is meaningful telemetry. |
| `perfFpsThreshold`        | `1`     | Max FPS change treated as "unchanged" (only when `suppressIdlePerfSamples` is on).         |

## Channel toggles (`capture`)

| Option                   | Default | Effect                                                                                                                                |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `capture.camera`         | `true`  | Camera-pose / view-direction samples.                                                                                                 |
| `capture.pointerMove`    | `true`  | Continuous pointer movement (`pointer_move`).                                                                                         |
| `capture.clicks`         | `true`  | Click / tap events (`pointer_click`).                                                                                                 |
| `capture.buttons`        | `true`  | Pointer down/up (`pointer_down` / `pointer_up`).                                                                                      |
| `capture.meshPicks`      | `true`  | Mesh interactions (`mesh_interaction`).                                                                                               |
| `capture.cameraGesture`  | `true`  | Navigation gestures (`camera_gesture`). See [events](/docs/guides/events/#camera-gestures-camera_gesture).                            |
| `capture.perf`           | `true`  | Frame performance (`frame_perf`).                                                                                                     |
| `capture.contextLoss`    | `true`  | WebGL/WebGPU `context_lost` / `context_restored`.                                                                                     |
| `capture.compileStall`   | `true`  | Shader compile stalls (`compile_stall`, Babylon only).                                                                                |
| `capture.meshVisibility` | `false` | Per-object dwell (`mesh_visibility`). See [mesh tracking](/docs/guides/mesh-tracking/#object-dwell-meshvisibility--opt-in).           |
| `capture.hoverDwell`     | `false` | Hover-hesitation capture (`hover_dwell`). See [mesh tracking](/docs/guides/mesh-tracking/#hover-hesitation-hover_dwell--opt-in).      |
| `capture.resourceSample` | `false` | GPU/memory footprint (`resource_sample`). See [performance](/docs/guides/performance/#gpu--memory-footprint-resource_sample--opt-in). |
| `capture.gaze`           | `false` | World-space gaze (`camera_sample.hitPoint`/`hitMesh`). See [performance](/docs/guides/performance/#world-space-gaze-gaze--opt-in).    |
| `capture.keyboard`       | `true`  | `input_action` for bound keys. Needs `keyBindings`; `false` disables it even with bindings. Not on Babylon Lite.                      |
| `capture.nodes`          | `true`  | `node_transform` for actors. Needs `actors` + `sampling.nodes`; `false` disables it even when configured.                             |
| `capture.bones`          | `true`  | Bone `node_transform`. Needs `actors` + `sampling.bones`; `false` disables it even when configured. Not on Babylon Lite.              |
| `capture.assetLoad`      | `true`  | Asset load timing (`asset_load`, PlayCanvas only).                                                                                    |

`meshVisibility`, `hoverDwell`, `resourceSample`, and `gaze` also take an options **object** to tune
them — documented on the [mesh tracking](/docs/guides/mesh-tracking/) and
[performance](/docs/guides/performance/) pages. The object only tunes a channel; the `capture` flag
is what turns it on. `trackScene` forwards `gaze` on every connector and `meshVisibility` on Babylon
only. The other objects go to the connector's collector.

## Input, actors & XR

| Option                     | Accepted by                 | Effect                                                                                                                        |
| -------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `keyBindings`              | `trackScene`, the collector | `KeyboardEvent.code` → action label. See [events](/docs/guides/events/#keybindings-allowlist).                                |
| `actors`                   | `trackScene`, the collector | Scene-actor map. See [mesh tracking](/docs/guides/mesh-tracking/#scene-actors-node_transform--opt-in).                        |
| `xr`                       | `trackScene`                | WebXR capture: opt-in on [Babylon](/docs/connectors/babylon/#webxr), on by default on [three](/docs/connectors/three/#webxr). |
| `cameraType`               | `trackScene`                | Override the detected navigation model (three and PlayCanvas).                                                                |
| `cameraGestureSensitivity` | the collector               | Scales the `camera_gesture` dead-zones: above `1` is less sensitive. Default `1`.                                             |

## Delivery & debug

These go straight to `trackScene`.

| Option            | Default        | Effect                                                                                                                                                           |
| ----------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flushIntervalMs` | `5000`         | Max time between network flushes. `0` disables the timer.                                                                                                        |
| `transport`       | beacon → fetch | Custom transport object, `{ send(batch) }`, e.g. to observe sends. Resolve `false` to re-queue a batch.                                                          |
| `disabled`        | `false`        | Collect nothing — e.g. to honor Do-Not-Track.                                                                                                                    |
| `debug`           | `false`        | Console debug logs.                                                                                                                                              |
| `jankFrameMs`     | `50`           | A rendered frame slower than this counts toward `frame_perf.longFrames`. Babylon and web exports only; three, PlayCanvas and Babylon Lite report no long frames. |

## Client options

These are `UptimizrClient` options, set by
[building the client yourself](#advanced-custom-client--beforesend).

| Option                       | Default | Effect                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `captureLifecycle`           | `true`  | Emit `viewport_resize` / `focus_change` / `visibility_change`.                                                                                                                                                                                                                                                                                |
| `resizeDebounceMs`           | `250`   | Debounce window for `viewport_resize`.                                                                                                                                                                                                                                                                                                        |
| `captureErrors`              | `false` | Opt-in `runtime_error` capture; **not** auto-redacted.                                                                                                                                                                                                                                                                                        |
| `captureGraphicsDiagnostics` | `false` | Opt-in engine `graphics_diagnostic` capture (GPU health); **not** auto-redacted. Captures WebGPU `device.lost`, WebGPU `uncapturederror` (rate-limited rollup), WebGL/WebGPU context-creation failure, shader compile/link failures, and sampled WebGL `gl.getError()` (Babylon + three). `context_lost` / `context_restored` stay always-on. |
| `captureShaderSource`        | `false` | Sub-opt-in to `captureGraphicsDiagnostics`: include raw shader source in shader-compile diagnostics. Off by default — shader source is application IP; even with diagnostics on, source is stripped unless this is set. Length-capped + `beforeSend`.                                                                                         |

| `batchSize` | `20` | Events buffered before an early network flush. |
| `maxQueueSize` | `1000` | Events retained while offline before the oldest are dropped. |
| `offload` | `main` | `"worker"` moves aggregation and serialization off the render thread. See [sdk-core](/docs/connectors/sdk-core/#worker-offload-opt-in). |
| `createWorker` | — | Construct the offload worker yourself, for bundlers that miss the default `new URL(…)` pattern. |
| `sdkVersion` | package value | Override the reported SDK version. |

**How often events are sent.** Every connector batches all event types into one request and
flushes on whichever comes first: the queue reaching `batchSize`, or `flushIntervalMs` elapsing
(plus an immediate flush on page unload). Raise `flushIntervalMs` to send fewer, larger requests;
lower it for fresher data (e.g. live dashboards). `trackScene` forwards `flushIntervalMs` on every
connector; `batchSize` stays at `20` unless you build the client yourself.

## Advanced: custom client & `beforeSend`

`trackScene` is the one-call path. For a client option such as `captureErrors`, a collector option
such as `hoverDwell`, a `beforeSend` hook (inspect / modify / **drop** each event — return `null` to
drop), or registering multiple collectors on one session, build the `UptimizrClient` yourself:

```ts
import { UptimizrClient } from "@uptimizr/sdk-core";
import {
  babylonCollector,
  readConnector,
  readDeviceCaps,
  readGraphics,
  readSceneMeta,
} from "@uptimizr/babylon";

const client = new UptimizrClient({
  projectId: "your-project-id",
  endpoint: "https://collect.example.com",
  batchSize: 50,
  captureErrors: true,
  beforeSend: (event) => (event.type === "pointer_move" ? null : event), // drop a channel, redact a field, sample
});

client.use(
  babylonCollector({
    scene,
    capture: { hoverDwell: true, resourceSample: true },
    hoverDwell: { minDwellMs: 800 },
    resourceSample: { intervalMs: 30000 },
  }),
);
client.start({
  device: readDeviceCaps(scene),
  graphics: readGraphics(scene),
  connector: readConnector(scene),
  scene: readSceneMeta(scene),
});
```

`beforeSend` runs on every event after the envelope is filled in — it's the right place to redact
[error](/docs/guides/sessions/#error-capture) fields or sample a noisy channel. It is **not** exposed
through `trackScene`; reach for the custom-client path when you need it.

## Privacy defaults

No cookies, no persistent client id; the `sessionId` is in-memory only. Never put PII in `meta`,
`track` props, or `user` (`user.id` must be pseudonymous/hashed). Reading raw per-session streams
through the API (needed for [replay](/docs/guides/replay/)) is opt-in on the collector via
`ENABLE_RAW_SESSION_RETENTION=true`, **and** additionally requires an API key holding the
`query:raw` [capability](/docs/deploy/collector/#api-keys-and-capabilities) — a plain `query` key
reads aggregates only.

Despite its name, the flag gates access, not storage. The collector always writes every event to
the store, including each event's full payload, because aggregates are computed from those rows at
query time. With the flag off, raw streams cannot be read through the API but remain in the store,
and there is no automatic event deletion. See [Privacy & configuration](/docs/deploy/privacy/).

## Collector-side keys, limits and auditing

Beyond the SDK options above, the collector scopes what a key may do:
[capabilities](/docs/deploy/collector/#api-keys-and-capabilities) (`query`, `query:raw`,
`annotate`, `ingest`), an optional per-key request budget, `GET /api/v1/whoami` for a key to
discover its own scope, and an [agent audit log](/docs/deploy/collector/#agent-audit-log) with
`AUDIT_RETENTION_DAYS`. See the [self-hosting guide](/docs/deploy/collector/) for the environment
variables and the `uptimizr new-key` CLI.

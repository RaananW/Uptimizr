---
title: Configuration reference
description: Every option accepted by trackScene / babylonCollector — camera, sampling, idle suppression, channel toggles, delivery, privacy.
---

Every option on this page is accepted by both `trackScene(scene, options)` and the lower-level
`babylonCollector(options)`. The same names apply across connectors (the engine-specific arguments —
`camera`, `renderer`, `canvas` — differ; see each [connector page](/docs/connectors/overview/)).

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
| `meta`             | object | —       | Extra `session_start` context: `sceneId`, `url`, `pageMeta`.                                                                                                   |
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
  // perSource: { leftController: 30, rightHand: 30 }, // XR
  // nodes / bones — scene actors, see Mesh & object tracking
}
```

Omitted channels keep conservative defaults (≈1 Hz camera, ≈4 Hz pointer, ≈0.5 Hz perf). There is no
enforced ceiling — higher fidelity just costs more storage. **Discrete** events (clicks, button
up/down, mesh interactions, scene changes, session start/end, custom, input actions, and the lifecycle
events) are always captured at 100% and cannot be rate-limited.

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

| Option                   | Default | Effect                                                                                                                |
| ------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `capture.camera`         | `true`  | Camera-pose / view-direction samples.                                                                                 |
| `capture.pointerMove`    | `true`  | Continuous pointer movement (`pointer_move`).                                                                         |
| `capture.clicks`         | `true`  | Click / tap events (`pointer_click`).                                                                                 |
| `capture.buttons`        | `true`  | Pointer down/up (`pointer_down` / `pointer_up`).                                                                      |
| `capture.meshPicks`      | `true`  | Mesh interactions (`mesh_interaction`).                                                                               |
| `capture.perf`           | `true`  | Frame performance (`frame_perf`).                                                                                     |
| `capture.contextLoss`    | `true`  | WebGL/WebGPU `context_lost` / `context_restored`.                                                                     |
| `capture.compileStall`   | `true`  | Shader compile stalls (`compile_stall`, Babylon only).                                                                |
| `capture.hoverDwell`     | `false` | Hover-hesitation capture (`hover_dwell`). See [mesh tracking](/docs/guides/mesh-tracking/#hover-hesitation).          |
| `capture.resourceSample` | `false` | GPU/memory footprint (`resource_sample`). See [performance](/docs/guides/performance/#gpu--memory-footprint).         |
| `capture.gaze`           | `false` | World-space gaze (`camera_sample.hitPoint`/`hitMesh`). See [performance](/docs/guides/performance/#world-space-gaze). |

`meshVisibility`, `hoverDwell`, `resourceSample`, and `gaze` also take an options **object** to tune
them — documented on the [mesh tracking](/docs/guides/mesh-tracking/) and
[performance](/docs/guides/performance/) pages.

## Lifecycle, delivery & misc

| Option                       | Default        | Effect                                                                                                                                                                                                                                                 |
| ---------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `captureLifecycle`           | `true`         | Emit `viewport_resize` / `focus_change` / `visibility_change`.                                                                                                                                                                                         |
| `resizeDebounceMs`           | `250`          | Debounce window for `viewport_resize`.                                                                                                                                                                                                                 |
| `captureErrors`              | `false`        | Opt-in `runtime_error` capture; **not** auto-redacted.                                                                                                                                                                                                 |
| `captureGraphicsDiagnostics` | `false`        | Opt-in engine `graphics_diagnostic` capture (GPU health); **not** auto-redacted. Currently captures WebGPU `device.lost` + `uncapturederror` (rate-limited rollup) (Babylon + three; WebGL no-op). `context_lost` / `context_restored` stay always-on. |
| `jankFrameMs`                | `50`           | A rendered frame slower than this counts toward `frame_perf.longFrames`.                                                                                                                                                                               |
| `batchSize`                  | `20`           | Events buffered before an early network flush.                                                                                                                                                                                                         |
| `flushIntervalMs`            | `5000`         | Max time between network flushes. `0` disables the timer.                                                                                                                                                                                              |
| `transport`                  | beacon → fetch | Custom delivery function (e.g. to observe sends).                                                                                                                                                                                                      |
| `disabled`                   | `false`        | Collect nothing — e.g. to honor Do-Not-Track.                                                                                                                                                                                                          |
| `debug`                      | `false`        | Console debug logs.                                                                                                                                                                                                                                    |

**How often events are sent.** Every connector batches all event types into one request and
flushes on whichever comes first: the queue reaching `batchSize`, or `flushIntervalMs` elapsing
(plus an immediate flush on page unload). Raise `flushIntervalMs` (or `batchSize`) to send fewer,
larger requests; lower it for fresher data (e.g. live dashboards). These are forwarded to
`@uptimizr/sdk-core` by `trackScene`, so they work identically across the Babylon, three.js, and
PlayCanvas connectors.

## Advanced: custom client & `beforeSend`

`trackScene` is the one-call path. For a custom transport, a `beforeSend` hook (inspect / modify /
**drop** each event — return `null` to drop), or registering multiple collectors on one session, build
the `UptimizrClient` yourself:

```ts
import { UptimizrClient } from "@uptimizr/sdk-core";
import { babylonCollector, readDeviceCaps, readSceneMeta } from "@uptimizr/babylon";

const client = new UptimizrClient({
  projectId: "your-project-id",
  endpoint: "https://collect.example.com",
  beforeSend: (event) => (event.type === "pointer_move" ? null : event), // drop a channel, redact a field, sample
});

client.use(babylonCollector({ scene }));
client.start({ device: readDeviceCaps(scene), scene: readSceneMeta(scene) });
```

`beforeSend` runs on every event after the envelope is filled in — it's the right place to redact
[error](/docs/guides/sessions/#error-capture) fields or sample a noisy channel. It is **not** exposed
through `trackScene`; reach for the custom-client path when you need it.

## Privacy defaults

No cookies, no persistent client id; the `sessionId` is in-memory only. Never put PII in `meta`,
`track` props, or `user` (`user.id` must be pseudonymous/hashed). Per-session raw retention
(needed for [replay](/docs/guides/replay/)) is opt-in on the collector via
`ENABLE_RAW_SESSION_RETENTION=true`.

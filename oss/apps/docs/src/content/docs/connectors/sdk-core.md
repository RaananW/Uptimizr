---
title: sdk-core (advanced)
description: Build an UptimizrClient directly for custom transports, beforeSend hooks, and multiple collectors.
lastUpdated: 2026-11-06
---

`trackScene` is the one-call path. When you need finer control — a custom transport, a `beforeSend`
hook to inspect/modify/drop events, or registering multiple collectors on one session — build the
[`UptimizrClient`](https://github.com/RaananW/Uptimizr/tree/main/oss/packages/sdk-core) yourself and
attach a connector's collector with `client.use(...)`.

## Example (Babylon)

```ts
import { UptimizrClient } from "@uptimizr/sdk-core";
import { babylonCollector, readDeviceCaps, readSceneMeta } from "@uptimizr/babylon";

const client = new UptimizrClient({
  projectId: "your-project-id",
  endpoint: "https://collect.example.com",
  // Inspect, modify, or drop each event before it is queued. Return null to drop.
  beforeSend: (event) => (event.type === "pointer_move" ? null : event),
});

client.use(babylonCollector({ scene }));
client.start({ device: readDeviceCaps(scene), scene: readSceneMeta(scene) });

// Same API as the trackScene return value:
client.track("add_to_cart", { sku: "ABC-123" });
client.setScene("level-2");
await client.stop("manual");
```

## Client configuration

| Option                       | Default        | Effect                                                                        |
| ---------------------------- | -------------- | ----------------------------------------------------------------------------- |
| `projectId`                  | —              | Your project id (required).                                                   |
| `endpoint`                   | —              | Collector base URL (required).                                                |
| `batchSize`                  | `20`           | Events queued before an early flush.                                          |
| `flushIntervalMs`            | `5000`         | Max time between flushes (`0` disables the timer).                            |
| `maxQueueSize`               | `1000`         | Events retained while offline before the oldest are dropped.                  |
| `beforeSend`                 | —              | Per-event hook; return `null` to drop. Runs after the envelope is filled in.  |
| `transport`                  | beacon → fetch | Custom transport object: `{ send(batch) }`. Resolve `false` to re-queue.      |
| `offload`                    | `main`         | Run aggregation + batching on the main thread or an opt-in worker.            |
| `createWorker`               | —              | Construct the offload worker yourself. Only consulted with `offload: worker`. |
| `captureLifecycle`           | `true`         | Emit `viewport_resize` / `focus_change` / `visibility_change`.                |
| `resizeDebounceMs`           | `250`          | Debounce window for `viewport_resize`.                                        |
| `captureErrors`              | `false`        | Opt-in `runtime_error` capture; not auto-redacted.                            |
| `captureGraphicsDiagnostics` | `false`        | Opt-in `graphics_diagnostic` capture; not auto-redacted.                      |
| `captureShaderSource`        | `false`        | Include raw shader source in shader-compile diagnostics.                      |
| `sdkVersion`                 | package value  | Override the reported SDK version.                                            |
| `disabled`                   | `false`        | Collect nothing (e.g. honor Do-Not-Track).                                    |
| `debug`                      | `false`        | Console debug logs.                                                           |

`trackScene` passes only `projectId`, `endpoint`, `flushIntervalMs`, `transport`, `disabled` and
`debug` to the client, so the other options in this table are set by building the client yourself.

`beforeSend` runs on every event after the envelope is filled in; use it to redact fields or sample
a noisy channel. It is **not** exposed through `trackScene` — reach for the custom-client path when
you need it.

A hand-built client only sends what you give `start()`. `trackScene` also fills in `graphics` and
`connector`; pass them yourself to keep them (`readGraphics(scene)` and `readConnector(scene)` on
the Babylon connector).

## Client API

| Member                      | What it does                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `sessionId`, `config`       | The in-memory session id and the resolved configuration.                             |
| `use(collector)`            | Register a capture plugin. After `start`, it starts immediately.                     |
| `start(meta?)`              | Emit `session_start`, schedule flushing, start collectors.                           |
| `track(name, props?)`       | Emit a `custom` event.                                                               |
| `trackInput(action, opts?)` | Emit an `input_action`.                                                              |
| `reportCapabilityChange(c)` | Emit a `capability_change`.                                                          |
| `setScene(sceneId)`         | Switch the active scene; emits `scene_change`.                                       |
| `emit(event)`               | Queue any schema event, minus the envelope. A no-op before `start` or when disabled. |
| `flush(opts?)`              | Send queued events now. `{ unload: true }` keeps the send on the main thread.        |
| `stop(reason?)`             | Emit `session_end`, flush, and tear down collectors and timers.                      |
| `setPositionProvider(fn)`   | Supply the camera position stamped on errors and diagnostics.                        |
| `now()`                     | Current timestamp in epoch ms.                                                       |

`emit` is how an app reports an event no connector captures for it, such as `asset_load`:

```ts
client.emit({ type: "asset_load", name: "hero.glb", loadMs: 842 });
```

## Custom collectors

A `Collector` is the extension point every connector is built on: a `name` plus a `start(ctx)` that
returns a handle with `stop()`. `ctx` is a `CollectorContext` carrying `config`, `sessionId`,
`emit`, `track`, `trackInput`, `reportCapabilityChange`, `setScene`, `setPositionProvider`,
`createAggregation` and `now`.

```ts
import type { Collector } from "@uptimizr/sdk-core";

const heartbeat: Collector = {
  name: "heartbeat",
  start(ctx) {
    const timer = setInterval(() => ctx.track("heartbeat"), 30_000);
    return { stop: () => clearInterval(timer) };
  },
};

client.use(heartbeat);
```

## Worker offload (opt-in)

`offload: "worker"` moves the SDK's **processing** phase off the render thread into a same-origin
module worker; `offload: "main"` (the default) keeps everything synchronous and is byte-for-byte
identical. Worker mode is purely a performance valve — correctness never depends on it, and it
silently falls back to the main thread where workers are unavailable (older embeds, restrictive CSP,
SSR, tests).

What moves to the worker when enabled:

- **Per-frame aggregation** — frame-time percentiles (p95/p99 + long-frame counts), node/bone
  matrix→position/quaternion/scale decomposition, mesh-visibility bucketing, transform idle-diffing,
  and camera-gesture classification. Connectors read live engine state into plain-number snapshots
  on the main thread (the only place engine state is reachable) and hand them to the aggregator,
  which finalizes the events in the worker.
- **Serialization + steady-state dispatch** — `JSON.stringify` and the `fetch`/`sendBeacon` for
  ordinary batches.

What always stays on the main thread: reading engine state (frustum tests, bounds, gaze rays, FPS,
pointer/keyboard observers) and the **terminal unload flush** on stop/`pagehide`, whose `sendBeacon`
reliability requires the page context. No new data is collected and the wire contract
(`@uptimizr/schema`) is unchanged — worker mode is an execution-location choice only. See
[ADR 0031](https://github.com/RaananW/Uptimizr/blob/main/docs/adr/0031-optional-worker-offload.md)
and [ADR 0044](https://github.com/RaananW/Uptimizr/blob/main/docs/adr/0044-connector-aggregation-offload.md).

## Anonymized users (opt-in)

`user` is opt-in and Uptimizr never derives it — you pass it explicitly and own the anonymization.
`user.id` MUST be pseudonymous or hashed (never an email, username, or raw account id); omit it to
stay fully anonymous. `user.traits` is an open map of non-identifying values for segmentation.

```ts
import { createHash } from "node:crypto"; // server-side, or hash before it reaches the client

const hashedUserId = createHash("sha256").update(`${rawUserId}:${dailySalt}`).digest("hex");

trackScene(scene, {
  projectId,
  endpoint,
  user: { id: hashedUserId, traits: { plan: "pro", locale: "en-US" } },
});
```

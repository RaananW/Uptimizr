# @uptimizr/sdk-core

The framework-agnostic Uptimizr capture runtime. It owns the **session**, an in-memory
**batching queue**, **flush scheduling**, and a cookieless **transport** — but knows nothing
about any specific 3D engine. Engine adapters (e.g. [`@uptimizr/babylon`](../sdk-babylon))
plug in as **collectors**.

Privacy by design: no cookies, no persistent client identifier. The `sessionId` lives only in
memory, and the server assigns the cookieless `visitorId` at ingestion time.

## Usage

```ts
import { UptimizrClient } from "@uptimizr/sdk-core";

const client = new UptimizrClient({
  projectId: "proj_123",
  endpoint: "https://collect.example.com",
});

client.start();
client.track("level_complete", { level: 3 });
// ... later, on teardown
await client.stop();
```

## Collectors (the extension point)

A **collector** is a capture plugin. Register one with `client.use()`; it receives a context for
emitting typed events and returns a handle for teardown. This is how new instrumentation is added
without modifying the core.

```ts
import type { Collector } from "@uptimizr/sdk-core";

const myCollector: Collector = {
  name: "my-collector",
  start(ctx) {
    const id = setInterval(() => ctx.emit({ type: "frame_perf", fps: 60 }), 1000);
    return { stop: () => clearInterval(id) };
  },
};

client.use(myCollector);
```

Engine adapters are just collectors that translate engine events into `@uptimizr/schema`
events. See the `add-connector` skill.

## Configuration

| Option            | Default         | Notes                                                    |
| ----------------- | --------------- | -------------------------------------------------------- |
| `projectId`       | —               | Required. Public project identifier.                     |
| `endpoint`        | —               | Required. Collector base URL.                            |
| `sdkVersion`      | package version | Stamped on every event.                                  |
| `batchSize`       | 20              | Flush when this many events are queued.                  |
| `flushIntervalMs` | 5000            | Periodic flush; `0` disables the timer.                  |
| `maxQueueSize`    | 1000            | Cap on retained events when offline.                     |
| `transport`       | beacon/fetch    | Swap in a custom `Transport`.                            |
| `offload`         | `"main"`        | `"worker"` runs serialization + dispatch in a Web Worker. |
| `beforeSend`      | —               | Inspect / modify / drop each event (filtering, privacy). |
| `disabled`        | false           | Collect nothing (e.g. honor Do-Not-Track).               |
| `debug`           | false           | Console debug logs.                                      |

## Transport

The default transport prefers `navigator.sendBeacon` (so batches survive page unload) and falls
back to `fetch` with `keepalive`. Provide your own via the `transport` option to integrate a
different delivery mechanism.

## Offloading work to a Web Worker

Capture (reading your 3D scene) always runs on the main thread, but the **processing** that
follows — serializing each batch and sending it over the network — does not have to. Set
`offload: "worker"` to move that steady-state work into a Web Worker, keeping it off the frame
loop:

```ts
const client = new UptimizrClient({
  projectId: "proj_123",
  endpoint: "https://collect.example.com",
  offload: "worker",
});
```

This is fully optional and safe by default:

- **Default is `"main"`** — identical to the behaviour without this option.
- **Never required for correctness.** If a worker cannot be created (no `Worker`, a restrictive
  CSP, server-side rendering), the client transparently falls back to the main thread.
- **The final flush on page unload always runs on the main thread**, where `navigator.sendBeacon`
  is reliable — so no events are lost when the tab closes.
- **A custom `transport` takes precedence**: supplying one keeps delivery on the main thread
  (the worker cannot run your transport closure).

If your bundler does not understand the default
`new Worker(new URL("./offloadWorker.js", import.meta.url))` pattern, supply your own worker via
the `createWorker` option.

## Scripts

```bash
pnpm --filter @uptimizr/sdk-core build
pnpm --filter @uptimizr/sdk-core typecheck
pnpm --filter @uptimizr/sdk-core test
```

Licensed under [Apache-2.0](./LICENSE).

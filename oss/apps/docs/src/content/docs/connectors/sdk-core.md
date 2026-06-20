---
title: sdk-core (advanced)
description: Build an UptimizrClient directly for custom transports, beforeSend hooks, and multiple collectors.
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

| Option            | Default        | Effect                                                            |
| ----------------- | -------------- | ----------------------------------------------------------------- |
| `projectId`       | —              | Your project id (required).                                       |
| `endpoint`        | —              | Collector base URL (required).                                    |
| `batchSize`       | `20`           | Events per network flush.                                         |
| `flushIntervalMs` | `5000`         | Max time between flushes (`0` disables the timer).                |
| `beforeSend`      | —              | Per-event hook; return `null` to drop. Runs after the envelope is filled in. |
| `transport`       | beacon → fetch | Custom delivery (e.g. to observe sends).                          |
| `offload`         | `main`         | Run batching on the main thread or a worker.                      |
| `disabled`        | `false`        | Collect nothing (e.g. honor Do-Not-Track).                        |

`beforeSend` runs on every event after the envelope is filled in; use it to redact fields or sample
a noisy channel. It is **not** exposed through `trackScene` — reach for the custom-client path when
you need it.

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

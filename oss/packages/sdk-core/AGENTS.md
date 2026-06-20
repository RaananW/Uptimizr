# AGENTS.md — @uptimizr/sdk-core

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

The **framework-agnostic** Uptimizr capture runtime. It owns the session, an in-memory batching
queue, flush scheduling, and a cookieless transport — but knows nothing about any specific 3D
engine. Engine adapters (e.g. `@uptimizr/babylon`) plug in as **collectors**.

Privacy by design: no cookies, no persistent client identifier. The `sessionId` lives only in
memory; the server assigns the cookieless `visitorId` at ingestion (ADR 0003).

## Install

```bash
pnpm add @uptimizr/sdk-core
```

## Canonical usage

```ts
import { UptimizrClient } from "@uptimizr/sdk-core";

const client = new UptimizrClient({
  projectId: "proj_123",
  endpoint: "https://collect.example.com",
});
client.start();
client.track("level_complete", { level: 3 });
await client.stop();
```

## Extension point — collectors

A **collector** is a capture plugin registered with `client.use()`. It receives a context for
emitting typed events and returns a handle for teardown:

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

Engine adapters are just collectors that translate engine events into `@uptimizr/schema` events.

## Rules for agents

- Emit events that conform to `@uptimizr/schema`; do not invent event shapes here.
- Respect privacy: never set or persist a client identifier; honor `disabled` / Do-Not-Track.
- Use `beforeSend` for filtering/redaction; use a custom `transport` for delivery changes.
- New instrumentation = a new collector, not a core modification.

## Key options

`projectId`_, `endpoint`_, `sdkVersion`, `batchSize` (20), `flushIntervalMs` (5000),
`maxQueueSize` (1000), `transport`, `beforeSend`, `disabled`, `debug`. (\* required)

## More

- Package reference: [README.md](./README.md)
- Integration guide: https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md

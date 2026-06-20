# AGENTS.md — @uptimizr/schema

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

The **single source of truth** for every Uptimizr analytics event. Client SDKs, the collector
server, and replay all import event shapes from here — **never redefine an event elsewhere**.
Built with [Zod](https://zod.dev): each event has a runtime schema and an inferred TypeScript
type. Events are **replay-complete** (ordered, timestamped, keyed by `sessionId`).

## Install

```bash
pnpm add @uptimizr/schema
```

## Canonical usage

```ts
import { anyEventSchema, collectRequestSchema, type CameraSampleEvent } from "@uptimizr/schema";

// Validate one event of unknown type (discriminated union on `type`).
const result = anyEventSchema.safeParse(incoming);

// Validate a batch posted to /api/v1/collect.
const batch = collectRequestSchema.parse(requestBody);
```

## Event envelope (shared by every event)

`projectId`, `visitorId` (server-set, daily-rotating hash — clients omit it), `sessionId`
(client-generated, in-memory), `ts` (epoch ms), `sdkVersion`, and optional `url` / `pageMeta`.

## Event catalog (v1 `type` values)

`session_start`, `session_end`, `frame_perf`, `camera_sample`, `pointer_move`, `pointer_click`,
`mesh_interaction`, `asset_load`, `custom`.

## Rules for agents

- **Events live once.** Import types/schemas from here; do not re-declare event shapes.
- Keep events **replay-complete**: ordered, timestamped, `sessionId`-keyed.
- Clients never set `visitorId` (privacy model — ADR 0003).
- To add an event type, use `defineEvent` and register it in `src/events/index.ts`; see the
  README extension section and the repo `add-event-type` skill.

## More

- Package reference: [README.md](./README.md)
- Integration guide: https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md

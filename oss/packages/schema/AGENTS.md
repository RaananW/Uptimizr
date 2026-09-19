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

## Config shapes (not events)

`funnelConfigSchema`, `sceneRegionsSchema` and `subscriptionSchema` are **configuration**
contracts, not analytics events: they are deliberately outside the event union and never reach
the public ingest path. `subscriptionSchema` (ADR 0051 §6) declares a standing predicate over a
registry metric — `{ name, metric, filters, evaluate: { every, window }, predicate, cooldown,
delivery[], enabled }` — with a closed predicate union (`threshold`, `anomaly`, `movers`,
`new_value`, `presence`). `parseDurationMs` / `formatDurationMs` convert its `"5m"`-style
literals.

## Rules for agents

- **Events live once.** Import types/schemas from here; do not re-declare event shapes.
- Some shapes here are **config / metadata, not events** — `sceneProxySchema`, `sceneRegionSchema` /
  `sceneRegionsSchema` (named scene regions), `funnelConfigSchema`, `queryV1Schema` (the analytics
  query DSL, ADR 0051 §3) and the project-metadata contracts `annotationSchema` /
  `glossaryEntrySchema` / `savedAnalysisSchema` (ADR 0051 §5). They are authored out-of-band and are
  deliberately absent from `anyEventSchema`; never add them to the union. Events stay read-only —
  metadata is written through the collector's `annotate`-gated endpoints, never through the ingest
  path (ADR 0051 §9).
- `queryV1Schema` validates a query's **shape** only. Whether `metric` names a real metric, and
  whether that metric accepts a given dimension or filter, is `validateQuery()` in
  `@uptimizr/metrics` — the vocabulary lives in the registry, and this package is the registry's
  dependency rather than the other way round. Both run, in that order, at the collector edge.
- Keep events **replay-complete**: ordered, timestamped, `sessionId`-keyed.
- Clients never set `visitorId` (privacy model — ADR 0003).
- To add an event type, use `defineEvent` and register it in `src/events/index.ts`; see the
  README extension section and the repo `add-event-type` skill.

## More

- Package reference: [README.md](./README.md)
- Integration guide: https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md

# @uptimizr/schema

The **single source of truth** for every Uptimizr analytics event. Client SDKs, the collector
server, and the replay package all import event shapes from here — they are never redefined
elsewhere.

Built with [Zod](https://zod.dev): each event has a runtime schema and an inferred TypeScript
type. Events are **replay-complete** (ordered, timestamped, keyed by `sessionId`) and the design
is **registry-based** so new events and fields can be added without breaking existing producers
or consumers.

## Install

```bash
pnpm add @uptimizr/schema
```

## Usage

```ts
import { anyEventSchema, collectRequestSchema, type CameraSampleEvent } from "@uptimizr/schema";

// Validate a single event of unknown type (discriminated union on `type`).
const result = anyEventSchema.safeParse(incoming);

// Validate a batch posted to /api/v1/collect.
const batch = collectRequestSchema.parse(requestBody);
```

## Event envelope

Every event carries a shared envelope:

| Field             | Notes                                                       |
| ----------------- | ----------------------------------------------------------- |
| `projectId`       | Public project identifier.                                  |
| `visitorId`       | **Server-set** daily-rotating hash. Clients omit it.        |
| `sessionId`       | Groups events from one visit (client-generated, in-memory). |
| `ts`              | Epoch milliseconds.                                         |
| `sdkVersion`      | Producing SDK version.                                      |
| `url`, `pageMeta` | Optional page context.                                      |

## Event catalog (v1)

| `type`             | Purpose                                                           |
| ------------------ | ----------------------------------------------------------------- |
| `session_start`    | Session begins; carries the device/GPU block (WebGL2 + WebGPU).   |
| `session_end`      | Session ends; duration + reason.                                  |
| `frame_perf`       | Sampled FPS / frame time.                                         |
| `camera_sample`    | Camera position, direction, target, fov — view-direction heatmap. |
| `pointer_move`     | Screen-normalized position + optional 3D hit + mesh.              |
| `pointer_click`    | As above plus button — click heatmap.                             |
| `camera_gesture`   | Typed navigation gesture (orbit/pan/dolly/zoom/roll/fly).         |
| `mesh_interaction` | Hover / pick / click / drag on a named mesh.                      |
| `asset_load`       | Asset name, bytes, load ms, time-to-first-frame.                  |
| `custom`           | Developer-defined `name` + open `props` record.                   |

## Adding a new event type (extension point)

1. Create `src/events/myEvent.ts`:

   ```ts
   import { z } from "zod";
   import { defineEvent } from "./defineEvent.js";

   export const myEventSchema = defineEvent("my_event", {
     someField: z.number(),
   });
   export type MyEvent = z.infer<typeof myEventSchema>;
   ```

2. Register it in `src/events/index.ts` (`eventSchemaList`, `anyEventSchema`, `eventSchemaByType`)
   and re-export it.
3. Add the literal `"my_event"` to `EVENT_TYPES` in `src/constants.ts`.
4. Add a test in `src/__tests__`.

`defineEvent` automatically wires in the shared envelope and the `type` discriminant, so the
union and all downstream exhaustiveness checks update from that single registration.

See also the repo-level `add-event-type` skill for threading a new event through the SDK,
collector, storage, and replay.

## Ingestion payload bounds

The collector's write endpoint (`POST /api/v1/collect`) is public and intentionally keyless
(the cookieless, no-PII privacy model), so every free-text and collection
field is bounded **at the schema boundary**. The caps live in [`src/limits.ts`](./src/limits.ts)
as the exported `LIMITS` constant and are shared by producers and the collector. An event that
exceeds any cap fails validation, and the whole batch is rejected with `400`.

| Bound                         | `LIMITS` key                                                                | Applies to              |
| ----------------------------- | --------------------------------------------------------------------------- | ----------------------- |
| Events per batch              | `maxBatchEvents`                                                            | `collectRequest.events` |
| Project / session id length   | `maxProjectIdLength` / `maxSessionIdLength`                                 | envelope                |
| SDK version / URL length      | `maxSdkVersionLength` / `maxUrlLength`                                      | envelope                |
| Page title / referrer / lang  | `maxTitleLength` / `maxReferrerLength` / `maxLanguageLength`                | `pageMeta`              |
| Mesh / asset name length      | `maxMeshNameLength` / `maxAssetNameLength`                                  | `mesh_*`, `asset_load`  |
| Custom name / value / count   | `maxCustomNameLength` / `maxCustomPropValueLength` / `maxCustomPropEntries` | `custom`                |
| User id / trait value / count | `maxUserIdLength` / `maxUserTraitValueLength` / `maxUserTraitEntries`       | `session_start.user`    |
| Scene description / camera    | `maxSceneDescriptionLength` / `maxCameraNameLength`                         | `session_start.scene`   |
| Scene-proxy mesh name / count | `maxSceneProxyMeshNameLength` / `maxSceneProxyMeshes`                       | `sceneProxy`            |

**Connectors must truncate locally** rather than rely on rejection. A huge scene should not send
an unbounded `sceneProxy.meshes` list and get the batch dropped: cap the list at
`LIMITS.maxSceneProxyMeshes` (keep the largest / most-relevant meshes), and still report the true
total in `meshCount` so the dashboard can show "N of M meshes". Likewise, clamp long mesh names,
custom-prop values, and user traits before emitting. The schema caps are a safety net, not the
primary mechanism.

## Scripts

```bash
pnpm --filter @uptimizr/schema build
pnpm --filter @uptimizr/schema typecheck
pnpm --filter @uptimizr/schema test
```

Licensed under [Apache-2.0](./LICENSE).

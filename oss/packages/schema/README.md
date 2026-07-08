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
| `sceneId`         | Optional developer-assigned scene/area id.                  |
| `url`, `pageMeta` | Optional page context.                                      |

## Event catalog (v1)

| `type`                | Purpose                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `session_start`       | Session begins; carries device, graphics, scene, connector, and opt-in user metadata.                               |
| `session_end`         | Session ends; duration + reason.                                                                                    |
| `frame_perf`          | Sampled FPS / frame-time window, with optional percentile/jank/render-scale/spatial fields.                         |
| `camera_sample`       | Camera position, direction, target, fov, and optional gaze hit — view-direction heatmap.                            |
| `node_transform`      | Replay-complete transforms for developer-declared scene actors / bones / subtree children.                          |
| `pointer_move`        | Screen-normalized position + optional 3D hit + input-source metadata.                                               |
| `pointer_click`       | Click heatmap event with screen/hit/button/input-source metadata.                                                   |
| `pointer_down`        | Pointer/button press transition.                                                                                    |
| `pointer_up`          | Pointer/button release transition.                                                                                  |
| `camera_gesture`      | Typed navigation gesture (orbit/pan/dolly/zoom/roll/fly/navigate).                                                  |
| `mesh_interaction`    | Hover / pick / click / drag / teleport on a named mesh.                                                             |
| `mesh_visibility`     | Bucketed per-object visibility / centered-time summary.                                                             |
| `hover_dwell`         | Hover hesitation summary for a mesh, with optional UV.                                                              |
| `compile_stall`       | Shader / pipeline / material compilation hitch duration.                                                            |
| `resource_sample`     | Opt-in low-rate GPU / memory footprint sample.                                                                      |
| `capability_change`   | App-reported capability / fidelity fallback or recovery.                                                            |
| `asset_load`          | Asset name, bytes, load ms, time-to-first-frame.                                                                    |
| `scene_change`        | Ordered marker for an active `sceneId` transition.                                                                  |
| `viewport_resize`     | Debounced viewport/canvas size marker.                                                                              |
| `visibility_change`   | Page visibility marker.                                                                                             |
| `focus_change`        | Window/canvas focus marker.                                                                                         |
| `context_lost`        | Rendering context lost marker.                                                                                      |
| `context_restored`    | Rendering context restored marker.                                                                                  |
| `graphics_diagnostic` | Opt-in engine/GPU-health signal (errors, shader-compile failures, context loss, `uncapturederror`). Off by default. |
| `runtime_error`       | Opt-in JavaScript error / unhandled rejection capture.                                                              |
| `input_action`        | Discrete keyboard/gamepad/app action event.                                                                         |
| `custom`              | Developer-defined `name` + open `props` record.                                                                     |

## Opt-in engine diagnostics (`graphics_diagnostic`)

`graphics_diagnostic` carries engine-authored GPU-health signals (ADR 0021 part 2): GPU
errors/warnings, shader-compile/link failures, richer context-loss reasons, WebGPU
`uncapturederror`, and sampled `gl.getError()`. It is a single engine-agnostic shape:

- `severity`: `info | warning | error | fatal`
- `category`: `context-loss | validation | out-of-memory | shader-compile | device-lost | fallback`
- `backend` (optional): the producing API surface, reusing the `graphics.api` enum.
- `message` / `code` (optional): length-capped free text; redact via `beforeSend`.
- `count` (optional): **rollup-or-marker discriminator** — omit for a single discrete
  incident; set it to aggregate that many incidents into one per-session rollup (the cheap
  default so an error storm can't flood ingestion).
- `position` (optional): best-effort camera world position for spatial diagnostic heatmaps.

**Off by default.** Capture is gated by the SDK's `captureGraphicsDiagnostics` flag (mirrors
JS error capture). `context_lost` / `context_restored` are exempt and stay always-on. The
`fallback` category is reserved for forward-compatibility and is not emitted by any connector
(engine-driven fallback stays in `capability_change`).

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

| Bound                            | `LIMITS` key                                                                          | Applies to              |
| -------------------------------- | ------------------------------------------------------------------------------------- | ----------------------- |
| Events per batch                 | `maxBatchEvents`                                                                      | `collectRequest.events` |
| Project / session id length      | `maxProjectIdLength` / `maxSessionIdLength`                                           | envelope                |
| SDK version / URL length         | `maxSdkVersionLength` / `maxUrlLength`                                                | envelope                |
| Page title / referrer / lang     | `maxTitleLength` / `maxReferrerLength` / `maxLanguageLength`                          | `pageMeta`              |
| Mesh / asset name length         | `maxMeshNameLength` / `maxAssetNameLength`                                            | `mesh_*`, `asset_load`  |
| Custom name / value / count      | `maxCustomNameLength` / `maxCustomPropValueLength` / `maxCustomPropEntries`           | `custom`                |
| User id / trait value / count    | `maxUserIdLength` / `maxUserTraitValueLength` / `maxUserTraitEntries`                 | `session_start.user`    |
| Scene description / camera       | `maxSceneDescriptionLength` / `maxCameraNameLength`                                   | `session_start.scene`   |
| Scene-proxy mesh name/path/count | `maxSceneProxyMeshNameLength` / `maxSceneProxyMeshPathLength` / `maxSceneProxyMeshes` | `sceneProxy`            |
| Node / bone / child path         | `maxNodeIdLength` / `maxBoneIdLength` / `maxChildPathLength`                          | `node_transform`        |
| Diagnostic message / code        | `maxGraphicsDiagnosticMessageLength` / `maxGraphicsDiagnosticCodeLength`              | `graphics_diagnostic`   |

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

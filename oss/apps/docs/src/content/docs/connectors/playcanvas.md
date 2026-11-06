---
title: PlayCanvas analytics
description: Add heatmaps, entity tracking, real-user FPS and session replay to a PlayCanvas app with the @uptimizr/playcanvas connector.
lastUpdated: 2026-11-06
---

The PlayCanvas connector. `playcanvas` is a peer dependency — the connector reads your existing
PlayCanvas instance and never bundles or mutates it.

## Install

```bash
npm install @uptimizr/playcanvas playcanvas
```

## Usage

Because PlayCanvas supports multiple camera entities with no single "active" camera, and the
connector reads FPS and the canvas from `app.graphicsDevice`, the camera `Entity` is an explicit
argument:

```ts
import { trackScene } from "@uptimizr/playcanvas";

const client = trackScene(app, cameraEntity, {
  projectId: "your-project",
  endpoint: "https://collect.example.com",
});

// later, on teardown
await client.stop("manual");
```

`trackScene` returns the `@uptimizr/sdk-core` `UptimizrClient`. Read `client.sessionId`, emit custom
events, or stop the session early.

## Coordinate frame

World-space data is normalized from PlayCanvas' native **right-handed, y-up** frame to the canonical
wire frame (**left-handed, y-up**) at the emission boundary; the session is attributed to the
`playcanvas` connector.

## Capture

Captures camera pose, pointer move/click (with optional raycast hit), mesh picks, FPS, and
**asset load timing** (`asset_load`, on by default — see below). Opt-in: mesh visibility, hover
dwell, resource sample, and gaze. Frame perf carries FPS without percentiles or long-frame counts.
It tears down all DOM listeners, timers, `frameend` handlers, and asset-registry listeners on stop.

### Asset load timing (`asset_load`)

The connector hooks the PlayCanvas [`app.assets`](https://developer.playcanvas.com/api/pc.AssetRegistry.html)
registry load lifecycle (`load:start` → `load` / `error`) and emits one `asset_load` per observed
load, carrying the asset's **name**, load **duration** (`loadMs`), and **byte size** (`bytes`, when
the engine knows it). Privacy (ADR 0003): only the asset's app-defined `name` is recorded — never the
file URL — and loads the connector didn't observe from the start (already-cached assets) are skipped
rather than reported with a fabricated duration. Disable with `capture: { assetLoad: false }`.

## First-person scenes (pointer lock)

When the canvas holds the browser [Pointer Lock](https://developer.mozilla.org/docs/Web/API/Pointer_Lock_API)
(first-person/FPS navigation), the OS cursor is hidden and the aim point is the fixed crosshair at the
viewport centre. The connector detects pointer lock and reports pointer/click events from screen centre
(`screen = [0.5, 0.5]`), raycasting from the centre — so the 2D pointer heatmap clusters at the centre
for locked scenes. Read the cursor-independent gaze / floor-plan heatmaps instead; cursor
(orbit/viewer) scenes are unaffected. See [Concepts → pointer lock](/docs/concepts/) (ADR 0034).

## Raycast probes

| Helper                                             | Returns                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `createSceneRaycaster(app, cameraEntity)`          | `(ndcX, ndcY) => { point, name } \| undefined`, the default pointer probe.           |
| `createGazeRaycaster(app, cameraEntity, options?)` | `() => { point, name } \| undefined`. Options: `maxDistance`, `meshes`, `predicate`. |

`playcanvasCollector` takes a `raycast` option to replace the pointer probe. `trackScene` does not.

`trackScene` also takes `cameraType` to override the detected navigation model on `session_start`:
PlayCanvas camera entities carry no orbit-vs-free-fly distinction, so pass
`cameraType: "arc-rotate"` for orbit viewers.

## Advanced

```ts
import { UptimizrClient } from "@uptimizr/sdk-core";
import { playcanvasCollector, readDeviceCaps } from "@uptimizr/playcanvas";

const client = new UptimizrClient({
  projectId: "your-project",
  endpoint: "https://collect.example.com",
});
client.use(playcanvasCollector({ app, camera: cameraEntity }));
client.start({ device: readDeviceCaps(app) });
```

`playcanvasCollector` is also where the `meshVisibility`, `hoverDwell` and `resourceSample` options
objects go; `trackScene` does not accept them. See
[sdk-core (advanced)](/docs/connectors/sdk-core/) for the full client API.

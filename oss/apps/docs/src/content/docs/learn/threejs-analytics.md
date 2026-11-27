---
title: The complete guide to analytics for three.js apps
description: What to measure in a three.js scene and how to capture it, from object clicks and view-direction heatmaps to real-user FPS and session replay, with working code.
lastUpdated: 2026-11-27
---

Analytics for a three.js app means measuring what happens **inside the canvas**: where visitors
look, which objects they click, where they move, what they never notice, and how smoothly the scene
runs on their devices. Page analytics can't do this, because everything three.js draws ends up in a
single `<canvas>` element. This guide covers what's worth measuring, how to capture it with
[`@uptimizr/three`](/docs/connectors/three/), and how to read the results.

Uptimizr is open source (Apache-2.0) and self-hosted. The examples below send data to a collector
you run yourself, and nothing goes to a third party.

## What you can measure

| Question                                 | Signal                                               | Captured                 |
| ---------------------------------------- | ---------------------------------------------------- | ------------------------ |
| Which objects do people click?           | Raycast hits on named meshes                         | By default               |
| What do they click that does nothing?    | Clicks that hit no geometry, and rapid repeat clicks | By default               |
| Which way do they look?                  | Camera direction, binned on a sphere                 | By default               |
| What do they actually look at?           | The camera-forward ray hitting geometry (gaze)       | Opt-in: `capture.gaze`   |
| Where do they stand and walk?            | Camera positions on the ground plane                 | By default               |
| How do they navigate?                    | Orbit, pan and zoom gestures                         | By default               |
| What do they hover but never click?      | Hover dwell on meshes                                | Opt-in: `hoverDwell`     |
| What's on screen but ignored?            | On-screen time against engagement, per mesh          | Opt-in: `meshVisibility` |
| Does it run smoothly on their device?    | FPS samples, by device and by position in the scene  | By default               |
| What happened in one particular session? | The ordered event stream, replayed in your scene     | Readable on opt-in       |
| Did they reach the goal?                 | Your own events, such as `add_to_cart`               | When you call `track()`  |

## Set up in three steps

**1. Run a collector.** The scaffolder creates a self-hosted collector with an embedded DuckDB file
and the dashboard:

```bash
npm create uptimizr@latest
```

See [Run the collector](/docs/deploy/collector/) for Docker, Postgres and other options.

**2. Install the connector.** `three` is a peer dependency, so the connector uses your copy:

```bash
npm install @uptimizr/three three
```

**3. Call `trackScene`** after you create the scene, camera and renderer:

```ts
import { trackScene } from "@uptimizr/three";

const client = trackScene(scene, camera, renderer, {
  projectId: "my-three-app",
  endpoint: "https://collect.example.com",
});
```

Open the dashboard and move around your scene. Heatmaps, the mesh ranking and performance charts
fill in as events arrive. Prefer a script tag? Every connector also ships a
[CDN bundle](/docs/connectors/cdn/).

## Name your meshes

Object analytics reports the name of the mesh a ray hit. Models exported from Blender or another
tool often arrive with names like `Cube012`, so give every object you care about a deliberate,
stable name:

```ts
const gltf = await loader.loadAsync("/models/chair.glb");
gltf.scene.getObjectByName("Cube012")!.name = "chair-seat";
gltf.scene.getObjectByName("Cylinder003")!.name = "chair-legs";
```

The name used is the mesh's own name, not its parent group's. Clone suffixes such as `Box.001` and
`Box.002` split one object across several rows, and an unnamed mesh reports an empty name.

## Turn on the opt-in signals

Gaze, hover and visibility capture are off by default, for privacy and cost. Turn on the ones you
need:

```ts
const client = trackScene(scene, camera, renderer, {
  projectId: "my-three-app",
  endpoint: "https://collect.example.com",
  capture: { gaze: true, hoverDwell: true, meshVisibility: true },
  gaze: { predicate: (object) => object.name !== "ground" },
});
```

Gaze adds one raycast per camera sample that's actually sent, not one per frame. It never adds a
timer, and a still camera costs nothing. It's a head-direction proxy, not eye tracking. See
[Performance & diagnostics → gaze](/docs/guides/performance/#world-space-gaze-gaze--opt-in) for the
details.

## Track your own events and scenes

Discrete moments that matter to your product are custom events. Areas, levels and views are
scenes:

```ts
client.track("add_to_cart", { sku: "CHAIR-01", finish: "walnut" });
client.setScene("showroom"); // later heatmaps and rankings can be filtered to this scene
```

Custom events can feed a per-session [funnel](/docs/api/query/), and every report accepts a
`scene` filter. See [Custom events & input](/docs/guides/events/) for keyboard actions, buttons and
capability changes.

## Controls, first-person scenes and WebXR

- **`OrbitControls` and other drag controls.** A press and release within 10 CSS pixels counts as a
  click. A longer drag counts as an orbit or pan gesture, so rotating the model doesn't log a click
  on whatever was under the cursor.
- **`PointerLockControls` and first-person scenes.** When the canvas holds pointer lock, the
  connector reports clicks from the crosshair at the centre of the screen. Read the gaze and
  floor-plan heatmaps for these scenes, because the screen-space pointer heatmap will cluster in the
  middle.
- **WebXR.** XR capture is on by default and idle until `renderer.xr` enters an immersive session.
  Controller, hand and gaze rays map to the same pointer and interaction events. Pass
  `xr: { raycast: createXrRaycaster(scene) }` to resolve them to hits. See
  [three.js → WebXR](/docs/connectors/three/#webxr).

## Read the results

The dashboard covers the common questions. Every view is also a [query API](/docs/api/query/)
endpoint you can call:

| You want                                 | Endpoint                                                      |
| ---------------------------------------- | ------------------------------------------------------------- |
| The most-clicked objects                 | `GET /api/v1/meshes/top`                                      |
| Clicks that hit nothing, and rage clicks | `GET /api/v1/clicks/dead`, `GET /api/v1/clicks/rage`          |
| Where people clicked, in 3D              | `GET /api/v1/heatmaps/world`                                  |
| Which way they looked                    | `GET /api/v1/heatmaps/camera`                                 |
| What their gaze rested on                | `GET /api/v1/heatmaps/gaze`                                   |
| Where they stood                         | `GET /api/v1/heatmaps/position`                               |
| Seen but ignored objects                 | `GET /api/v1/meshes/blind-spots`                              |
| FPS percentiles and FPS by device        | `GET /api/v1/perf/distribution`, `GET /api/v1/perf/by-device` |
| Where in the scene FPS drops             | `GET /api/v1/heatmaps/perf`                                   |

```http
GET /api/v1/meshes/top?since=2026-11-01&limit=20&format=summary
x-api-key: your-project-api-key
```

For the heatmaps in detail, including drawing one inside your own three.js scene, see
[Heatmaps for three.js scenes](/docs/learn/threejs-heatmaps/). You can also
[ask an AI agent](/docs/learn/ai-agent-3d-analytics/) questions such as "which objects do people
look at but never click?" against the same data.

## Replay a session in your own scene

Replay re-drives a recorded session in your real three.js scene, not in a video. It moves your
camera and gives you callbacks for each pointer and mesh event:

```ts
import { fetchSessionEvents, ReplayPlayer } from "@uptimizr/replay";
import { createThreeReplayDriver } from "@uptimizr/replay/three";

const events = await fetchSessionEvents({ endpoint, apiKey, sessionId });
const driver = createThreeReplayDriver({
  scene,
  camera,
  onPointer: (screen, hitPoint, hitMesh) => {
    /* draw a cursor or flash the mesh */
  },
});

new ReplayPlayer(events, driver, { speed: 1 }).play();
```

Reading a session's events needs `ENABLE_RAW_SESSION_RETENTION=true` on the collector and an API
key with the `query:raw` capability. See [Session replay](/docs/guides/replay/) and
[Session replay for WebGL](/docs/learn/webgl-session-replay/) for how this compares with canvas
video recording.

## Privacy

The default setup writes no cookies and stores no persistent identifier in the browser. The session
id lives in memory, and visitors are counted with a hash that the server computes and rotates daily.
Gaze, hover and visibility capture are off until you turn them on. See
[Privacy & configuration](/docs/deploy/privacy/). Whether you need a consent banner still depends
on your jurisdiction and what you capture.

## Build it yourself, or use a connector?

A click logger takes about ten lines with a `THREE.Raycaster`, and
[Track which objects users click in three.js](/docs/learn/track-object-clicks-threejs/) shows how.
The work is everything around it: batching and delivery when the tab closes, misses, pointer lock,
drags, storage, aggregation, heatmaps and replay. A connector is worth it once you need more than
one of those.

## Common questions

**Does this work with React Three Fiber?** Yes. `@uptimizr/r3f` is a thin layer over the three.js
connector. See [Analytics for React Three Fiber apps](/docs/learn/react-three-fiber-analytics/).

**Does it work with WebGPU?** Yes. Pass a `WebGPURenderer` from `three/webgpu` the same way you'd
pass a `WebGLRenderer`. The session reports WebGPU as its graphics API, and the connector also
reports WebGPU device loss as a diagnostic. Older `@uptimizr/three` releases typed `renderer` as
`WebGLRenderer`, so on those, TypeScript needs a cast.

**Do I need a server?** Yes, a collector, which you run yourself. It's a single Node process with
an embedded database. To try the reports first, open the [live demo](https://demo.uptimizr.com),
which runs entirely in your browser.

**Can I use it alongside Google Analytics, PostHog or Mixpanel?** Yes. Keep those for pages,
acquisition and conversions, and use Uptimizr for what happens in the canvas. See
[Uptimizr vs PostHog and Mixpanel](/docs/learn/posthog-mixpanel-3d-analytics/).

**What does it cost?** Uptimizr is free and open source. You pay for wherever you host the
collector.

## Next steps

- Follow the [Quickstart](/docs/quickstart/) for the shortest path to a first heatmap.
- Read the [three.js connector reference](/docs/connectors/three/) for every option.
- Try the [live demo](https://demo.uptimizr.com) to explore the reports without installing
  anything.

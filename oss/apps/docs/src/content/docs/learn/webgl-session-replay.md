---
title: Session replay for WebGL and 3D scenes
description: Why DOM session replay struggles with WebGL, how canvas image capture compares with event-based replay, and how to replay a session in your own 3D scene.
lastUpdated: 2026-11-06
---

Standard session replay records changes to the page's DOM, and a WebGL scene isn't in the DOM. The
recording can capture the `<canvas>` element, but not what it drew. There are two ways around this:
capture the canvas as images, or record what happened in the scene and play it back in the scene
itself. Which one suits you depends on what you need from a replay.

## Why WebGL replays often come back blank

DOM replay tools rebuild a page from recorded markup, and a canvas's contents aren't part of that
markup. They have to be captured separately as pixels, and that's opt-in for good reason:

- **rrweb**, the library behind many replay tools, has [`recordCanvas` off by
  default](https://github.com/rrweb-io/rrweb/blob/master/guide.md), and its `UNSAFE_replayCanvas`
  playback option removes the replay iframe's script sandbox.
- **PostHog** [can capture WebGL canvases](https://posthog.com/docs/session-replay/canvas-recording)
  as images. It's off by default, runs at 4 frames per second by default (configurable up to 12), and
  isn't covered by DOM-based masking.
- **Sentry** [has to enable `preserveDrawingBuffer`](https://docs.sentry.io/platforms/javascript/session-replay/troubleshooting/)
  to export images from 3D and WebGL canvases, and notes that this can hurt canvas performance.

## Two approaches compared

|                                          | Canvas image capture                    | Event-based replay                            |
| ---------------------------------------- | --------------------------------------- | --------------------------------------------- |
| What's recorded                          | Images of the canvas                    | Camera poses, pointer, mesh and custom events |
| How it plays back                        | As a low-frame-rate video               | Live, in your own scene                       |
| Can your own code react during playback? | No                                      | Yes, events reach your callbacks              |
| Runtime cost                             | Encoding images on the visitor's device | Sending small batches of events               |
| Text and data in the scene               | Captured as pixels, and need masking    | Only what you choose to send                  |
| Works after you change the scene         | Yes, it's a recording                   | Only if your scene still matches              |
| Setup                                    | Usually one setting                     | A connector, plus code to host playback       |

If you want a quick visual check and already use one of those tools, image capture is the simplest
option. If you want playback in your real scene, with your own cursor and highlights, or need to avoid recording what's on screen,
event-based replay fits better.

## Replay a session in your own scene

Uptimizr uses the event-based approach. A connector records an ordered, timestamped event stream, and
[`@uptimizr/replay`](/docs/guides/replay/) re-drives it: camera poses are applied directly, while
pointer, mesh and custom events reach your callbacks so you can draw a cursor or highlight an object.

```bash
npm install @uptimizr/replay
```

```ts
import { fetchSessionEvents, ReplayPlayer } from "@uptimizr/replay";
import { createThreeReplayDriver } from "@uptimizr/replay/three";

const events = await fetchSessionEvents({ endpoint, apiKey, sessionId });
const driver = createThreeReplayDriver({
  scene,
  camera,
  onPointer: (screen, hitPoint, hitMesh, type) => {
    /* draw a cursor or flash the mesh */
  },
});

const player = new ReplayPlayer(events, driver, { speed: 1 });
player.play();
```

Drivers are available for three.js, Babylon.js, Babylon Lite and PlayCanvas.

## What you need to know first

- **Access is opt-in.** Reading a session needs `ENABLE_RAW_SESSION_RETENTION=true` on the collector
  and an API key with the `query:raw`
  [capability](/docs/deploy/collector/#api-keys-and-capabilities). The flag controls access, not
  storage: [events are stored either way](/docs/deploy/privacy/#raw-session-access-is-opt-in).
- **Your scene must match the session.** Replay runs in the scene you provide, so a major scene
  change can make older sessions line up poorly.
- **It re-applies, it doesn't re-simulate.** Objects that move on their own, such as NPCs, doors and
  elevators, only replay if you record them as
  [scene actors](/docs/guides/mesh-tracking/#scene-actors-node_transform--opt-in).
- **Name your meshes.** Stable mesh names keep events attached to the right objects.

## Next steps

- Read the full [session replay guide](/docs/guides/replay/), including scene actors and backdrops.
- See how replay fits with the [privacy model](/docs/deploy/privacy/).
- Explore the reports in the [live demo](https://demo.uptimizr.com).

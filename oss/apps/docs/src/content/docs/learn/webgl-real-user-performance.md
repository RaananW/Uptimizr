---
title: Measure real-user FPS in WebGL
description: Measure WebGL and WebGPU frame rate on real visitor devices, why average FPS misleads, and how to find slow devices, slow locations and lost sessions.
lastUpdated: 2026-11-06
---

Your scene's performance on your development machine says little about how it runs for visitors. To
find out, you need to measure frame rate in the browser on their real devices, report it to a server,
and compare it across sessions. This is real-user monitoring, and for 3D it matters more than for most
pages because one weak GPU can make a scene unusable.

## Measure FPS yourself

`requestAnimationFrame` fires once per rendered frame, so you can count frames over a time window:

```ts
let frames = 0;
let windowStart = performance.now();

function tick(now: number) {
  frames += 1;
  const elapsed = now - windowStart;
  if (elapsed >= 2000) {
    report({ fps: (frames * 1000) / elapsed });
    frames = 0;
    windowStart = now;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
```

Keep two things in mind. Browsers pause `requestAnimationFrame` in background tabs, so a long gap
isn't a performance problem. The rate is also capped by the display's refresh rate and any throttling
the browser applies.

Tools such as `stats.js` are useful while you develop, but they only show the numbers on your own
screen.

## Why average FPS misleads

An average hides the experience you most need to find:

- **Stutter disappears.** A scene averaging 58 FPS can still hitch noticeably. Frame-time percentiles
  and a count of long frames show this; the average doesn't.
- **Heavy users outvote everyone.** If you pool every sample, long sessions on fast machines drown out
  short sessions on slow ones. Calculating per session and then aggregating gives each visitor one
  vote.
- **Adaptive quality can hide problems.** A scene might hold 60 FPS only because the renderer lowered
  its resolution, so read the frame rate together with the render scale.

## Capture it with a connector

Each Uptimizr connector reports performance by default, with no extra code, on a slow timer of about
one sample every two seconds. Each `frame_perf` sample includes FPS, frame time, 95th- and
99th-percentile frame time, long-frame counts, device pixel ratio and render scale. See
[Real-user performance](/docs/guides/performance/) for all the fields.

```ts
import { trackScene } from "@uptimizr/three";

const client = trackScene(scene, camera, renderer, {
  projectId: "your-project",
  endpoint: "https://collect.example.com",
  capture: { resourceSample: true }, // optional: triangle counts and JS heap
});
```

Connectors for [Babylon.js](/docs/connectors/babylon/), [PlayCanvas](/docs/connectors/playcanvas/)
and [other engines](/docs/connectors/overview/) work the same way.

## Questions to ask of the data

| Question                                | Endpoint                        | What it tells you                                             |
| --------------------------------------- | ------------------------------- | ------------------------------------------------------------- |
| How smooth is the scene overall?        | `GET /api/v1/perf/distribution` | FPS percentiles per session, then aggregated                  |
| Who's having a bad time?                | `GET /api/v1/perf/by-device`    | Median FPS by GPU, graphics backend, browser, OS and mobile   |
| How often do frames run long?           | `GET /api/v1/perf/jank`         | The median session's long-frame rate and the worst decile's   |
| Is FPS only good because quality fell?  | `GET /api/v1/perf/render-scale` | The FPS headline paired with the resolution actually rendered |
| Which scene or level is slowest?        | `GET /api/v1/perf/by-scene`     | Median FPS for each scene                                     |
| Where in the scene does it slow down?   | `GET /api/v1/heatmaps/perf`     | FPS by camera position, as a 3D heatmap                       |
| Does stutter actually cost us sessions? | `GET /api/v1/perf/churn`        | Sessions that ended shortly after an FPS dip or compile stall |
| Do slow loads make people leave?        | `GET /api/v1/load-bounce`       | Bounce rate by initial load time                              |

## Engine differences

- The **Babylon.js** connector fills in camera position automatically for the spatial FPS heatmap.
  Other connectors need to set it on the event they emit.
- **Shader compile stalls** are Babylon-only, because three.js has no equivalent engine hook.
- **JS heap** comes from `performance.memory`, which is Chromium-only, so it's left out in other
  browsers instead of being reported as zero.

## Next steps

- Read the [real-user performance guide](/docs/guides/performance/).
- Follow the [Quickstart](/docs/quickstart/) to start collecting from your scene.
- Explore performance panels in the [live demo](https://demo.uptimizr.com).
